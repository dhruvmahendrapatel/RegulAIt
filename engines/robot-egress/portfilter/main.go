// ADR-0364 S3 — the robot egress proxy's entry point: smokescreen v0.1.0's own main.go (MIT, Copyright (c) 2016 Stripe:
// the same configuration, flags, role function and JSON logging), plus the port filter (portfilter.go) as its
// PostDecisionRequestHandler, and the front filter (front.go) on the address the flags name, with Smokescreen moved
// to a loopback listener behind it (D-2026-11-22-07). Nothing else differs from the upstream binary.
package main

import (
	"log"
	"net"
	"net/http"
	"strconv"

	"github.com/sirupsen/logrus"
	"github.com/stripe/smokescreen/cmd"
	"github.com/stripe/smokescreen/pkg/smokescreen"
)

// smokescreen's defaultRoleFromRequest, unchanged: a role comes only from a client certificate's CommonName (a
// sandbox presents none, so `allow_missing_role: true` sends every request to the ACL's default rule)
func defaultRoleFromRequest(req *http.Request) (string, error) {
	if req.TLS == nil {
		return "", smokescreen.MissingRoleError("defaultRoleFromRequest requires TLS")
	}
	if len(req.TLS.PeerCertificates) == 0 {
		return "", smokescreen.MissingRoleError("client did not provide certificate")
	}
	return req.TLS.PeerCertificates[0].Subject.CommonName, nil
}

func main() {
	conf, err := cmd.NewConfiguration(nil, nil)
	if err != nil {
		logrus.Fatalf("Could not create configuration: %v", err)
	} else if conf != nil {
		conf.RoleFromRequest = defaultRoleFromRequest
		conf.Log.Formatter = &logrus.JSONFormatter{}

		// fail closed: no valid ports file, no proxy
		filter, err := LoadPorts(PortsFile)
		if err != nil {
			conf.Log.Fatalf("regulait port filter: %v", err)
		}
		conf.PostDecisionRequestHandler = filter.Check

		// the front filter takes the flags' address (--listen-ip, --listen-port); Smokescreen listens on loopback only,
		// so nothing outside this process reaches it. Either listener failing stops the proxy (fail closed).
		front, err := net.Listen("tcp", net.JoinHostPort(conf.Ip, strconv.Itoa(int(conf.Port))))
		if err != nil {
			conf.Log.Fatalf("regulait front filter: %v", err)
		}
		inner, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			conf.Log.Fatalf("regulait front filter: the loopback listener: %v", err)
		}
		conf.Listener = inner
		go func() {
			err := NewFront(filter, inner.Addr().String(), conf.Log.WithField("component", "front")).Serve(front)
			conf.Log.Fatalf("regulait front filter stopped: %v", err)
		}()

		adapter := &smokescreen.Log2LogrusWriter{
			Entry: conf.Log.WithField("stdlog", "1"),
		}
		log.SetOutput(adapter)
		log.SetFlags(0)
		smokescreen.StartWithConfig(conf, nil)
	}
	// Otherwise, --help or --version was passed and handled by NewConfiguration, so do nothing
}
