# RegulAIt operator (ADR-0304). Everything runs locally; nothing here talks to a real cluster.
CONTROLLER_GEN := go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.23.0
SETUP_ENVTEST  := go run sigs.k8s.io/controller-runtime/tools/setup-envtest@v0.25.2
ENVTEST_K8S    := 1.37.0
ENVTEST_DIR    ?= $(CURDIR)/bin/envtest

.PHONY: generate manifests test fmt vet licences
generate:
	$(CONTROLLER_GEN) object:headerFile=hack/boilerplate.go.txt paths=./api/...

manifests:
	$(CONTROLLER_GEN) rbac:roleName=regulait-operator crd paths=./... output:crd:artifacts:config=config/crd output:rbac:artifacts:config=config/rbac

fmt:
	@test -z "$$(gofmt -l .)" || { gofmt -l .; exit 1; }

vet:
	go vet ./...

test: fmt vet
	KUBEBUILDER_ASSETS="$$($(SETUP_ENVTEST) use $(ENVTEST_K8S) --bin-dir $(ENVTEST_DIR) -p path)" go test -race -count=1 ./...

licences:
	bash scripts/check-licences.sh
