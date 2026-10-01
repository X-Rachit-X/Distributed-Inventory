# Kubernetes manifests

**Production-shaped, schema-validated, not yet run on a cluster.** Every overlay
builds with `kubectl kustomize` and passes `kubeconform -strict` against the
Kubernetes schemas. They have not been applied to a live cluster, so treat a
first run as a test. The step-by-step walkthrough (kind cluster first, then a
real one) is in [docs/learn/08-deployment.md](../../docs/learn/08-deployment.md),
Level 4.

```
base/                 the application: 8 services, edge (Caddy + console), ingress,
                      migrate Job, HPAs, PDBs, ConfigMap. No Secret (see below).
infra/                single-replica PostgreSQL, Redis, Kafka (+ topics Job) for a
                      LEARNING cluster. Real deployments use managed services instead.
overlays/local/       kind / k3d / minikube: images :dev, 1 replica each, Secret
                      generated from overlays/local/secrets.env (git-ignored)
overlays/production/  registry images by tag, your domain, TLS via cert-manager;
                      the Secret comes from your secret manager
```

Quick start on a local cluster (details in the guide):

```bash
cp deploy/k8s/infra/secrets.env.example deploy/k8s/infra/secrets.env
cp deploy/k8s/overlays/local/secrets.env.example deploy/k8s/overlays/local/secrets.env
kubectl kustomize --load-restrictor LoadRestrictionsNone deploy/k8s/infra | kubectl apply -f -
kubectl apply -k deploy/k8s/overlays/local
```

Design points:

- **No Secret in the base.** A placeholder Secret would be applied as-is, and
  production mode accepts any non-development value, so a cluster could run on
  `replace-me`. Each overlay must supply `tessera-secrets`; the keys are listed in
  `base/secret.example.yaml`, which no kustomization applies.
- **Readiness vs liveness.** Liveness is `/health` (process alive) and never
  checks dependencies, so a database outage does not become a restart loop.
  Readiness is `/ready` and does.
- **Graceful shutdown.** `terminationGracePeriodSeconds: 30`. On SIGTERM a
  service fails readiness first, drains in-flight requests, then releases its
  saga / outbox leases so another replica picks the work up immediately.
- **Stateless replicas.** Correctness lives in PostgreSQL, so every service can
  scale horizontally. Workers claim work with `SKIP LOCKED` and leases; running
  N replicas needs no leader election.
- **Consumers scale to partition count.** notification and discovery cannot
  usefully exceed the partition count of their topics (6 for inventory.events).
- **PodDisruptionBudgets** keep a quorum of reservation and inventory replicas
  up during node drains, because those carry in-flight holds.
- **One way in.** The Ingress sends everything to the edge, which splits `/api`
  (gateway) from the console. Caddy and the gateway both accept
  `X-Forwarded-For` only from private-network hops, so the client IP that rate
  limiting sees is the real one.
- **Migrations are a Job**, and a Job's template is immutable: delete the
  finished `migrate` Job before applying a new image.
