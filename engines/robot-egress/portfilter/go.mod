// ADR-0364 S3 — the robot egress binary: stripe/smokescreen v0.1.0 used as a library, plus ONE hook (portfilter.go)
// that refuses a CONNECT whose host:port is not one of the run's targets. Not a fork: smokescreen is the published
// module, unmodified (checked against go.sum and the checksum database). The patched dependency versions below are
// the fixed releases the image takes for smokescreen's vulnerable pins (patched, never allow-listed); minimal version
// selection lifts smokescreen's own lower requirements to them.
module regulait.invalid/robot-egress

go 1.26.0

require (
	github.com/sirupsen/logrus v1.9.3
	github.com/stripe/smokescreen v0.1.0
)

require (
	github.com/DataDog/datadog-go v4.5.1+incompatible // indirect
	github.com/Microsoft/go-winio v0.6.1 // indirect
	github.com/armon/go-proxyproto v0.0.0-20170620220930-48572f11356f // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/carlmjohnson/versioninfo v0.22.4 // indirect
	github.com/cespare/xxhash/v2 v2.1.2 // indirect
	github.com/golang/protobuf v1.5.2 // indirect
	github.com/hashicorp/golang-lru v1.0.2 // indirect
	github.com/matttproud/golang_protobuf_extensions v1.0.1 // indirect
	github.com/patrickmn/go-cache v2.1.0+incompatible // indirect
	github.com/prometheus/client_golang v1.13.0 // indirect
	github.com/prometheus/client_model v0.2.0 // indirect
	github.com/prometheus/common v0.37.0 // indirect
	github.com/prometheus/procfs v0.8.0 // indirect
	github.com/rs/xid v1.2.1 // indirect
	github.com/stripe/goproxy v0.0.0-20260826103935-0cd07c409a76 // indirect
	golang.org/x/mod v0.41.0 // indirect
	golang.org/x/net v0.62.0 // indirect
	golang.org/x/sync v0.24.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	golang.org/x/tools v0.51.0 // indirect
	google.golang.org/protobuf v1.33.0 // indirect
	gopkg.in/urfave/cli.v1 v1.20.0 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
)
