package controller

import (
	"fmt"
	"net/netip"
	"strings"

	v1alpha1 "github.com/dhruvmahendrapatel/regulait/deploy/operator/api/v1alpha1"
)

// registryHost returns the registry part of a repository: the first path segment when it looks like a host
// (has a dot or a port, or is localhost), else Docker Hub, which is never an air-gapped registry.
func registryHost(repo string) string {
	first, _, found := strings.Cut(repo, "/")
	if found && (strings.ContainsAny(first, ".:") || first == "localhost") {
		return first
	}
	return "docker.io"
}

func isPrivate(p netip.Prefix) bool {
	for _, r := range privateRanges {
		pr := netip.MustParsePrefix(r)
		if pr.Bits() <= p.Bits() && pr.Contains(p.Addr()) {
			return true
		}
	}
	return false
}

// Validate checks what the CRD schema cannot express. It returns a stable reason and a message.
func Validate(in *v1alpha1.RegulaitInstallation) (reason, msg string, ok bool) {
	s := in.Spec

	if regs := s.Image.AllowedRegistries; len(regs) > 0 {
		host := registryHost(s.Image.Repository)
		if !contains(regs, host) {
			return "RegistryNotAllowed", fmt.Sprintf("image registry %q is not in image.allowedRegistries", host), false
		}
	} else if s.Mode == v1alpha1.ModeAirGapped {
		return "RegistryNotAllowed", "air_gapped requires image.allowedRegistries", false
	}

	if s.Mode == v1alpha1.ModeAirGapped && s.Egress.AllowPublicEgress {
		return "PublicEgressRefused", "air_gapped refuses egress.allowPublicEgress", false
	}

	for field, list := range map[string][]string{"egress.allowedCIDRs": s.Egress.AllowedCIDRs, "egress.databaseCIDRs": s.Egress.DatabaseCIDRs} {
		for _, c := range list {
			p, err := netip.ParsePrefix(c)
			if err != nil || p != p.Masked() {
				return "InvalidCIDR", fmt.Sprintf("%s entry %q is not a canonical CIDR", field, c), false
			}
			if s.Mode == v1alpha1.ModeAirGapped && !isPrivate(p) {
				return "PublicEgressRefused", fmt.Sprintf("air_gapped allows only private ranges; %s entry %q is not one", field, c), false
			}
		}
	}

	if s.Backup.DestinationClaimName != "" && !s.Backup.Disabled {
		if s.Backup.Image == nil {
			return "BackupImageMissing", "backup.destinationClaimName is set but backup.image is not", false
		}
		// The backup image comes from the same registries as the gateway's.
		if regs := s.Image.AllowedRegistries; len(regs) > 0 && !contains(regs, registryHost(s.Backup.Image.Repository)) {
			return "RegistryNotAllowed", fmt.Sprintf("backup image registry %q is not in image.allowedRegistries", registryHost(s.Backup.Image.Repository)), false
		}
	}
	return "", "", true
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}
