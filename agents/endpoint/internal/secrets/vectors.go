package secrets

import (
	"encoding/json"
	"strings"
)

// Vector is one entry of testdata/vectors.json: an input assembled from parts at run time (so no file holds a
// key-shaped literal) and the rule ids both engines must report for it.
type Vector struct {
	Name   string       `json:"name"`
	Parts  []VectorPart `json:"parts"`
	Expect []string     `json:"expect"`
}

// VectorPart is a literal or a repeated character.
type VectorPart struct {
	Lit string `json:"lit,omitempty"`
	Rep string `json:"rep,omitempty"`
	N   int    `json:"n,omitempty"`
}

// Input assembles the vector's text.
func (v Vector) Input() string {
	var b strings.Builder
	for _, p := range v.Parts {
		b.WriteString(p.Lit)
		if p.Rep != "" {
			b.WriteString(strings.Repeat(p.Rep, p.N))
		}
	}
	return b.String()
}

// ParseVectors reads testdata/vectors.json.
func ParseVectors(data []byte) ([]Vector, error) {
	var f struct {
		Vectors []Vector `json:"vectors"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	return f.Vectors, nil
}
