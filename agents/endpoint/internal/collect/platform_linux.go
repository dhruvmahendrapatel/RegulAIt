package collect

import "github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"

func platformRoots() map[contract.Root]string {
	return map[contract.Root]string{contract.RootSystemApplications: "/usr/share/applications"}
}

func platformRegistry() Registry { return nil }

func platformPlistToXML() func([]byte) ([]byte, error) { return nil }
