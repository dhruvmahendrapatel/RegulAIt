package controller

import (
	"fmt"
	"net/netip"
	"sort"
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

func within(p netip.Prefix, ranges []string) bool {
	for _, r := range ranges {
		pr := netip.MustParsePrefix(r)
		if pr.Bits() <= p.Bits() && pr.Contains(p.Addr()) {
			return true
		}
	}
	return false
}

func overlapsAny(p netip.Prefix, ranges []string) bool {
	for _, r := range ranges {
		if netip.MustParsePrefix(r).Overlaps(p) {
			return true
		}
	}
	return false
}

func isPrivate(p netip.Prefix) bool { return within(p, privateRanges) }

// metadataHosts are the cloud instance metadata endpoints (AWS, GCP, Azure, ECS task metadata, the AWS IPv6 IMDS).
// They are refused in every egress list, the DNS list included.
var metadataHosts = []string{"169.254.169.254/32", "169.254.170.2/32", "169.254.170.23/32", "fd00:ec2::254/128"}

// checkCIDR applies ADR-0180 to one egress entry. No list may overlap a link-local range (the metadata endpoints live
// there) or a metadata host; air_gapped admits private ranges only. The DNS list admits private ranges and one
// link-local host address (NodeLocal DNSCache listens on one, for example 169.254.20.10), since it opens port 53 only.
func checkCIDR(mode v1alpha1.Mode, field, c string) (reason, msg string, ok bool) {
	p, err := netip.ParsePrefix(c)
	if err != nil || p != p.Masked() {
		return "InvalidCIDR", fmt.Sprintf("%s entry %q is not a canonical CIDR", field, c), false
	}
	if overlapsAny(p, metadataHosts) {
		return "MetadataEgressRefused", fmt.Sprintf("%s entry %q reaches a cloud instance metadata address", field, c), false
	}
	if field == "egress.dns.cidrs" {
		if isPrivate(p) || (within(p, linkLocalRanges) && p.IsSingleIP()) {
			return "", "", true
		}
		return "PublicEgressRefused", fmt.Sprintf("%s entry %q must be a private range or one link-local address", field, c), false
	}
	if overlapsAny(p, linkLocalRanges) {
		return "MetadataEgressRefused", fmt.Sprintf("%s entry %q overlaps a link-local range, where the cloud metadata endpoints are", field, c), false
	}
	if mode == v1alpha1.ModeAirGapped && !isPrivate(p) {
		return "PublicEgressRefused", fmt.Sprintf("air_gapped allows only private ranges; %s entry %q is not one", field, c), false
	}
	return "", "", true
}

// PublicEgress lists what a valid spec opens beyond private ranges (allowPublicEgress, public CIDRs), so the controller
// can report it on every reconcile (ADR-0180: a relaxation is visible).
func PublicEgress(in *v1alpha1.RegulaitInstallation) []string {
	var out []string
	if in.Spec.Egress.AllowPublicEgress {
		out = append(out, "egress.allowPublicEgress (public addresses on 443)")
	}
	lists := map[string][]string{"egress.allowedCIDRs": in.Spec.Egress.AllowedCIDRs, "egress.databaseCIDRs": in.Spec.Egress.DatabaseCIDRs}
	if s3 := in.Spec.Backup.S3; s3 != nil && !in.Spec.Backup.Disabled {
		lists["backup.s3.egressCIDRs"] = s3.EgressCIDRs
		if s3.PodIdentity {
			out = append(out, "backup.s3.podIdentity (backup pods reach the EKS Pod Identity agent 169.254.170.23 on 80)")
		}
	}
	for field, list := range lists {
		for _, c := range list {
			if p, err := netip.ParsePrefix(c); err == nil && !isPrivate(p) {
				out = append(out, fmt.Sprintf("%s %s", field, c))
			}
		}
	}
	sort.Strings(out)
	return out
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

	var dnsCIDRs []string
	if s.Egress.DNS != nil {
		dnsCIDRs = s.Egress.DNS.CIDRs
	}
	for _, f := range []struct {
		field string
		list  []string
	}{{"egress.allowedCIDRs", s.Egress.AllowedCIDRs}, {"egress.databaseCIDRs", s.Egress.DatabaseCIDRs}, {"egress.dns.cidrs", dnsCIDRs}} {
		for _, c := range f.list {
			if reason, msg, ok := checkCIDR(s.Mode, f.field, c); !ok {
				return reason, msg, false
			}
		}
	}

	if s.Backup.DestinationClaimName != "" && s.Backup.S3 != nil {
		return "BackupDestinationConflict", "set backup.destinationClaimName or backup.s3, not both", false
	}
	if (s.Backup.DestinationClaimName != "" || s.Backup.S3 != nil) && !s.Backup.Disabled {
		if s.Backup.Image == nil {
			return "BackupImageMissing", "a backup destination is set but backup.image is not", false
		}
		// The backup images come from the same registries as the gateway's.
		images := map[string]string{"backup.image": s.Backup.Image.Repository}
		if s.Backup.S3 != nil {
			images["backup.s3.uploaderImage"] = s.Backup.S3.UploaderImage.Repository
		}
		for _, field := range []string{"backup.image", "backup.s3.uploaderImage"} {
			repo, set := images[field]
			if !set {
				continue
			}
			if regs := s.Image.AllowedRegistries; len(regs) > 0 && !contains(regs, registryHost(repo)) {
				return "RegistryNotAllowed", fmt.Sprintf("%s registry %q is not in image.allowedRegistries", field, registryHost(repo)), false
			}
		}
		if s3 := s.Backup.S3; s3 != nil {
			if len(s3.EgressCIDRs) == 0 {
				return "BackupEgressMissing", "backup.s3.egressCIDRs must name the S3 and STS endpoints", false
			}
			for _, c := range s3.EgressCIDRs {
				if reason, msg, ok := checkCIDR(s.Mode, "backup.s3.egressCIDRs", c); !ok {
					return reason, msg, false
				}
			}
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
