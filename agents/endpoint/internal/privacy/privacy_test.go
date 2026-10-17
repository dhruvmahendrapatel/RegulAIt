package privacy

import (
	"errors"
	"testing"
)

func TestCheck(t *testing.T) {
	id := Identity{HomeDir: "/home/jdoe", UserName: "jdoe", Hostname: "jdoe-laptop.corp.example"}
	ok := []string{
		`{"facts":[{"location":{"root":"home","path":".config/example/settings.json"}}]}`,
		`{"identifier":"com.example.jdoex"}`, // a token that merely contains the name
		`{"path":"Example.app"}`,
	}
	for _, b := range ok {
		if err := id.Check([]byte(b)); err != nil {
			t.Errorf("%s refused: %v", b, err)
		}
	}
	bad := []string{
		`{"path":"/home/jdoe/.config/x"}`,
		`{"path":"Users/JDOE/x"}`,
		`{"gap":"jdoe-laptop"}`,
		`{"gap":"jdoe-laptop.corp.example"}`,
		`{"keyName":"jdoe"}`,
	}
	for _, b := range bad {
		if err := id.Check([]byte(b)); !errors.Is(err, ErrIdentifying) {
			t.Errorf("%s accepted", b)
		}
	}
	win := Identity{HomeDir: `C:\Users\jdoe`, UserName: `CORP\jdoe`, Hostname: "WS-0042"}
	for _, b := range []string{`{"p":"C:\\Users\\jdoe\\x"}`, `{"p":"c:/users/jdoe/x"}`, `{"h":"ws-0042"}`} {
		if err := win.Check([]byte(b)); !errors.Is(err, ErrIdentifying) {
			t.Errorf("windows %s accepted", b)
		}
	}
	// names shorter than three characters are not compared as tokens
	if err := (Identity{UserName: "ab"}).Check([]byte(`{"x":"ab"}`)); err != nil {
		t.Error(err)
	}
}
