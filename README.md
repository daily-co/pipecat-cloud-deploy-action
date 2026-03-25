# Deploy to Pipecat Cloud — GitHub Action

A GitHub Action that builds and deploys your [Pipecat](https://github.com/pipecat-ai/pipecat) agent to [Pipecat Cloud](https://pipecat.daily.co). Use it in your CI/CD workflows to automate deployments whenever you push code.

## Features

- **Cloud builds** — build Docker images directly in Pipecat Cloud infrastructure (no Docker or registry needed)
- **Smart caching** — identical build contexts are detected and reused automatically
- **Readiness polling** — waits for the deployment to become available before marking the step as successful
- **Full control** — configure scaling, regions, secrets, and more via action inputs

## Quick Start

### Build and deploy from source (cloud build)

Point the action at your repo (with a `Dockerfile`) and it handles everything:

```yaml
name: Deploy to Pipecat Cloud

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build and Deploy to Pipecat Cloud
        uses: daily-co/pipecat-cloud-deploy-action@v2
        with:
          api-key: ${{ secrets.PIPECAT_API_KEY }}
          agent-name: my-agent
          cloud-build: true
          secret-set: my-secrets
```

### Deploy a pre-built image

If you build your image separately (or use another CI step), pass the fully-tagged image:

```yaml
- name: Deploy to Pipecat Cloud
  uses: daily-co/pipecat-cloud-deploy-action@v2
  with:
    api-key: ${{ secrets.PIPECAT_API_KEY }}
    agent-name: my-agent
    image: ghcr.io/my-org/my-bot:v1.2.3
    image-credentials: my-registry-secret
    secret-set: my-secrets
    region: us-east-1
```

### Reuse an existing cloud build

If you already have a build ID from a previous run or the `pcc` CLI:

```yaml
- name: Deploy to Pipecat Cloud
  uses: daily-co/pipecat-cloud-deploy-action@v2
  with:
    api-key: ${{ secrets.PIPECAT_API_KEY }}
    agent-name: my-agent
    build-id: build_abc123
    secret-set: my-secrets
```

## Inputs

### Required

| Input        | Description                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-key`    | Pipecat Cloud **Private** API key. Store as a [GitHub secret](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions). Must be a Private key, not a Public key. |
| `agent-name` | Name of the agent to deploy.                                                                                                                                                                                            |

### Cloud Build (optional)

| Input           | Default      | Description                                                                  |
| --------------- | ------------ | ---------------------------------------------------------------------------- |
| `cloud-build`   | `false`      | Enable Pipecat Cloud Build (builds the image in the cloud).                  |
| `build-context` | `.`          | Build context directory path.                                                |
| `dockerfile`    | `Dockerfile` | Path to the Dockerfile (relative to build context).                          |
| `build-id`      |              | Reuse an existing cloud build ID (skips the build step).                     |
| `build-timeout` | `600`        | Max seconds to wait for cloud build completion.                              |

> **No Docker or registry required:** Cloud builds run entirely in Pipecat Cloud infrastructure. You don't need Docker installed on the runner, registry credentials, or `packages: write` permissions.

### Pre-built Image (optional)

| Input               | Description                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| `image`             | Pre-built Docker image with tag (e.g. `ghcr.io/my-org/my-bot:v1.2.3`).             |
| `image-credentials` | Name of the image pull secret set in Pipecat Cloud (for private registries).        |

### Deploy (optional)

| Input                 | Default                        | Description                                                  |
| --------------------- | ------------------------------ | ------------------------------------------------------------ |
| `secret-set`          |                                | Name of the secret set for runtime secrets.                  |
| `region`              |                                | Deployment region. Uses the organization default if omitted. |
| `min-agents`          | `0`                            | Minimum agents to keep warm (0-50).                          |
| `max-agents`          | `10`                           | Maximum concurrent agents (1-50).                            |
| `agent-profile`       |                                | Agent profile name.                                          |
| `enable-managed-keys` | `false`                        | Enable managed keys.                                         |
| `wait-for-ready`      | `true`                         | Poll until the deployment is ready.                          |
| `wait-timeout`        | `90`                           | Max seconds to wait for deployment readiness.                |
| `api-url`             | `https://api.pipecat.daily.co` | Override the Pipecat Cloud API base URL.                     |

## Outputs

| Output         | Description                                                 |
| -------------- | ----------------------------------------------------------- |
| `build-id`     | The Pipecat Cloud Build ID (when using cloud build).        |
| `service-name` | The deployed service/agent name.                            |

## Examples

### Cloud build with custom Dockerfile

```yaml
- name: Deploy to Pipecat Cloud
  uses: daily-co/pipecat-cloud-deploy-action@v2
  with:
    api-key: ${{ secrets.PIPECAT_API_KEY }}
    agent-name: my-agent
    organization: ${{ vars.PIPECAT_ORG_ID }}
    cloud-build: true
    dockerfile: docker/Dockerfile.prod
    build-context: .
    secret-set: prod-secrets
    region: us-east-1
    min-agents: 1
    max-agents: 5
```

### Deploy without waiting for readiness

```yaml
- name: Deploy to Pipecat Cloud
  uses: daily-co/pipecat-cloud-deploy-action@v2
  with:
    api-key: ${{ secrets.PIPECAT_API_KEY }}
    agent-name: my-agent
    organization: ${{ vars.PIPECAT_ORG_ID }}
    cloud-build: true
    wait-for-ready: false
```

### Use outputs in a subsequent step

```yaml
- name: Deploy
  id: deploy
  uses: daily-co/pipecat-cloud-deploy-action@v2
  with:
    api-key: ${{ secrets.PIPECAT_API_KEY }}
    agent-name: my-agent
    organization: ${{ vars.PIPECAT_ORG_ID }}
    cloud-build: true

- name: Print deploy info
  run: |
    echo "Build ID: ${{ steps.deploy.outputs.build-id }}"
    echo "Service name: ${{ steps.deploy.outputs.service-name }}"
```

## Setup

1. **Create a Pipecat Cloud Private API key** in the [Pipecat Cloud dashboard](https://pipecat.daily.co). Make sure to select **Private** (not Public) when creating the key.
2. **Add the API key as a GitHub secret** named `PIPECAT_API_KEY` (or any name you prefer) in your repository settings under _Settings > Secrets and variables > Actions_.
3. **Add the action** to your workflow file (see examples above).

## License

BSD 2-Clause License. See [LICENSE](LICENSE) for details.
