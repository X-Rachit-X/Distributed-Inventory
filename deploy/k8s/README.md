# Kubernetes manifests

**Production-shaped, not production-proven.** These manifests have not been
exercised on a real cluster. They exist to show how the services would be run:
probes, resources, disruption budgets, autoscaling and graceful shutdown. Do not
cite them as evidence of production readiness.

```
kubectl apply -k deploy/k8s/overlays/local
```

Assumes PostgreSQL, Redis, Kafka and Elasticsearch are provided (managed
services in a real deployment) and reachable at the addresses in
`base/configmap.yaml`. Secrets in `base/secret.example.yaml` are placeholders.

Design points:

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
