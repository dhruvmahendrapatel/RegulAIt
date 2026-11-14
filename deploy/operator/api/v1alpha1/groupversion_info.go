// Package v1alpha1 holds the RegulaitInstallation API (ADR-0304).
// +kubebuilder:object:generate=true
// +groupName=deploy.regulait.ai
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	// GroupVersion is the API group and version of the objects in this package.
	GroupVersion = schema.GroupVersion{Group: "deploy.regulait.ai", Version: "v1alpha1"}

	// SchemeBuilder registers the types of this package with a scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

	// AddToScheme adds the types of this package to a scheme.
	AddToScheme = SchemeBuilder.AddToScheme
)
