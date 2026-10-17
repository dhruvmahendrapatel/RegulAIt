package auth

import (
	"bytes"
	"context"
	"crypto"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// MaxResponseBytes caps every response body the agent reads.
const MaxResponseBytes = 1 << 20

// Response is a read, bounded response.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

// Code is the refusal's `error` member, or "".
func (r *Response) Code() string {
	var e contract.ErrorBody
	_ = json.Unmarshal(r.Body, &e)
	return e.Error
}

// HTTPError is a non-2xx answer the caller acts on.
type HTTPError struct {
	Op     string
	Status int
	Code   string
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s: HTTP %d (%s)", e.Op, e.Status, e.Code)
	}
	return fmt.Sprintf("%s: HTTP %d", e.Op, e.Status)
}

// Retryable reports whether the request may be tried again later (rate limits and server errors).
func (e *HTTPError) Retryable() bool { return e.Status == 429 || e.Status == 408 || e.Status >= 500 }

// Client holds the device key's DPoP-bound self token. Safe for one goroutine at a time.
type Client struct {
	Issuer   string
	HTTP     *http.Client
	Key      crypto.Signer
	ClientID string

	mu          sync.Mutex
	nonce       string
	access      string
	expires     time.Time
	rotateAfter time.Time
}

// Send is one request with no access token (enrolment and registration, which carry a bearer secret).
func Send(ctx context.Context, c *http.Client, method, u string, header http.Header, body []byte) (*Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if body == nil {
		req.Body = http.NoBody
	}
	for k, v := range header {
		req.Header[k] = v
	}
	res, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, MaxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxResponseBytes {
		return nil, errors.New("the response is larger than the agent reads")
	}
	return &Response{Status: res.StatusCode, Header: res.Header, Body: b}, nil
}

func (c *Client) keepNonce(r *Response) {
	if n := r.Header.Get("DPoP-Nonce"); n != "" && len(n) <= 512 {
		c.nonce = n
	}
}

// RotateDue reports whether the gateway's last token response asked for the key to be rotated by now.
func (c *Client) RotateDue(now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.rotateAfter.IsZero() && !now.Before(c.rotateAfter)
}

// token returns a cached self token, or gets one: `client_credentials`, `private_key_jwt`, DPoP, resource the
// endpoint-agent routes. A `use_dpop_nonce` answer is retried once with the gateway's nonce.
func (c *Client) token(ctx context.Context) (string, error) {
	if c.access != "" && time.Until(c.expires) > 30*time.Second {
		return c.access, nil
	}
	endpoint := c.Issuer + contract.RouteToken
	for attempt := 0; attempt < 2; attempt++ {
		assertion, err := ClientAssertion(c.Key, c.ClientID, endpoint)
		if err != nil {
			return "", err
		}
		proof, err := DPoPProof(c.Key, http.MethodPost, endpoint, c.nonce, "")
		if err != nil {
			return "", err
		}
		form := url.Values{
			"grant_type":            {"client_credentials"},
			"client_id":             {c.ClientID},
			"client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"},
			"client_assertion":      {assertion},
			"resource":              {c.Issuer + contract.ResourcePath},
		}
		h := http.Header{"Content-Type": {"application/x-www-form-urlencoded"}, "Dpop": {proof}}
		res, err := Send(ctx, c.HTTP, http.MethodPost, endpoint, h, []byte(form.Encode()))
		if err != nil {
			return "", err
		}
		c.keepNonce(res)
		if res.Status == http.StatusBadRequest && res.Code() == contract.ErrUseDPoPNonce && attempt == 0 {
			continue
		}
		if res.Status != http.StatusOK {
			return "", &HTTPError{Op: "token", Status: res.Status, Code: res.Code()}
		}
		var tr map[string]any
		if err := json.Unmarshal(res.Body, &tr); err != nil {
			return "", &HTTPError{Op: "token", Status: res.Status, Code: "unparseable"}
		}
		tok, _ := tr["access_token"].(string)
		typ, _ := tr["token_type"].(string)
		if tok == "" || !strings.EqualFold(typ, "DPoP") {
			return "", &HTTPError{Op: "token", Status: res.Status, Code: "not_a_dpop_token"}
		}
		expiresIn, _ := tr["expires_in"].(float64)
		if expiresIn <= 0 {
			expiresIn = 60
		}
		c.access, c.expires = tok, clock().Add(time.Duration(expiresIn)*time.Second)
		c.rotateAfter = time.Time{}
		if ra, ok := tr[contract.RotateAfterMember].(float64); ok && ra > 0 {
			c.rotateAfter = time.Unix(int64(ra), 0)
		}
		return tok, nil
	}
	return "", &HTTPError{Op: "token", Status: http.StatusBadRequest, Code: contract.ErrUseDPoPNonce}
}

// Do sends an authorized request to an endpoint-agent route. extra, when set, adds headers per attempt (the report
// signature is made fresh for each). A `use_dpop_nonce` challenge is retried once with the new nonce; another
// 401 drops the token and retries once with a fresh one.
func (c *Client) Do(ctx context.Context, method, path string, body []byte, extra func(http.Header) error) (*Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	u := c.Issuer + path
	nonceRetried, refreshed := false, false
	for {
		tok, err := c.token(ctx)
		if err != nil {
			return nil, err
		}
		proof, err := DPoPProof(c.Key, method, u, c.nonce, tok)
		if err != nil {
			return nil, err
		}
		h := http.Header{"Authorization": {"DPoP " + tok}, "Dpop": {proof}}
		if body != nil {
			h.Set("Content-Type", "application/json")
		}
		if extra != nil {
			if err := extra(h); err != nil {
				return nil, err
			}
		}
		res, err := Send(ctx, c.HTTP, method, u, h, body)
		if err != nil {
			return nil, err
		}
		c.keepNonce(res)
		if res.Status != http.StatusUnauthorized {
			return res, nil
		}
		if strings.Contains(res.Header.Get("WWW-Authenticate"), contract.ErrUseDPoPNonce) && !nonceRetried {
			nonceRetried = true
			continue
		}
		if res.Code() == contract.ErrDeviceRevoked || refreshed {
			return res, nil
		}
		refreshed = true
		c.access = ""
	}
}
