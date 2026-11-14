// Command manager runs the RegulAIt operator (ADR-0304).
//
// Secure defaults: it watches exactly one namespace (WATCH_NAMESPACE, required), serves no metrics unless
// --metrics-bind-address is set (and then over HTTPS with authentication and authorization), and holds a leader
// lease so two replicas never reconcile at once.
package main

import (
	"flag"
	"fmt"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	v1alpha1 "github.com/dhruvmahendrapatel/regulait/deploy/operator/api/v1alpha1"
	"github.com/dhruvmahendrapatel/regulait/deploy/operator/internal/controller"
)

// +kubebuilder:rbac:groups=coordination.k8s.io,namespace=regulait-system,resources=leases,verbs=get;list;watch;create;update;patch;delete

func main() {
	var metricsAddr, probeAddr string
	var leaderElect bool
	flag.StringVar(&metricsAddr, "metrics-bind-address", "0", `Metrics address, for example ":8443"; "0" turns metrics off.`)
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "Health and readiness probe address.")
	flag.BoolVar(&leaderElect, "leader-elect", true, "Hold a leader lease so only one replica reconciles.")
	opts := zap.Options{Development: false}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	setupLog := ctrl.Log.WithName("setup")

	ns := os.Getenv("WATCH_NAMESPACE")
	if ns == "" {
		fmt.Fprintln(os.Stderr, "WATCH_NAMESPACE is required: the operator watches one namespace and holds a Role there, never a ClusterRole")
		os.Exit(2)
	}

	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(v1alpha1.AddToScheme(scheme))

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme: scheme,
		Cache:  cache.Options{DefaultNamespaces: map[string]cache.Config{ns: {}}},
		Metrics: metricsserver.Options{
			BindAddress:    metricsAddr,
			SecureServing:  true,
			FilterProvider: filters.WithAuthenticationAndAuthorization,
		},
		HealthProbeBindAddress:  probeAddr,
		LeaderElection:          leaderElect,
		LeaderElectionID:        "regulait-operator.deploy.regulait.ai",
		LeaderElectionNamespace: ns,
	})
	if err != nil {
		setupLog.Error(err, "unable to create manager")
		os.Exit(1)
	}

	if err := (&controller.Reconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorder("regulait-operator"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller")
		os.Exit(1)
	}
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("starting manager", "namespace", ns)
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "manager exited")
		os.Exit(1)
	}
}
