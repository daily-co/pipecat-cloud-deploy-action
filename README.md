# Deploy to Pipecat Cloud — GitHub Action

A GitHub Action that builds, pushes, and deploys your [Pipecat](https://github.com/pipecat-ai/pipecat) agent to [Pipecat Cloud](https://www.pipecat.ai/cloud). Use it in your CI/CD workflows to automate deployments whenever you push code.

## Features

- **Build & push** Docker images automatically, or deploy a pre-built image
- **Zero Docker commands** — the action handles `docker build`, `docker login`, and `docker push` for you
- **Readiness polling** — waits for the deployment to become available before marking the step as successful
- **Full control** — configure scaling, regions, secrets, and more via action inputs

## Quick Start

### Build and deploy from source

Point the action at your repo (with a `Dockerfile`) and it handles everything:

```yaml
name: Deploy to Pipecat Cloud

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      packages: write  # needed for GHCR push
    steps:
      - uses: actions/checkout@v4

      - name: Build and Deploy to Pipecat Cloud
        uses: pipecat-ai/pipecat-cloud-deploy-action@v1
        with:
          api-key: ${{ secrets.PIPECAT_API_KEY }}
          agent-name: my-agent
          build: true
          image: ghcr.io/${{ github.repository }}
          registry-username: ${{ github.actor }}
          registry-password: ${{ secrets.GITHUB_TOKEN }}
          secret-set: my-secrets
```

### Deploy a pre-built image

If you build your image separately (or use another CI step), pass the fully-tagged image:

```yaml
- name: Deploy to Pipecat Cloud
  uses: pipecat-ai/pipecat-cloud-deploy-action@v1
  with:
    api-key: ${{ secrets.PIPECAT_API_KEY }}
    agent-name: my-agent
    image: ghcr.io/my-org/my-bot:v1.2.3
    secret-set: my-secrets
    region: us-east-1
```

## Inputs

### Required

| Input        | Description                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api-key`    | Pipecat Cloud **Private** API key. Store as a [GitHub secret](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions). Must be a Private key, not a Public key. |
| `agent-name` | Name of the agent to deploy.                                                                                                                                       |
| `image`      | Docker image name. When `build` is enabled the action auto-appends the tag. When `build` is disabled, must include a tag (e.g. `my-image:v1.0`).                   |

### Docker Build (optional)

These inputs are only used when `build` is set to `true`.

| Input               | Default             | Description                                          |
| ------------------- | ------------------- | ---------------------------------------------------- |
| `build`             | `false`             | Enable Docker build, tag, and push before deploying. |
| `registry-username` |                     | Registry username for `docker login`.                |
| `registry-password` |                     | Registry password or token for `docker login`.       |
| `tag`               | `${{ github.sha }}` | Image tag. Defaults to the git commit SHA.           |
| `dockerfile`        | `Dockerfile`        | Path to the Dockerfile.                              |
| `docker-context`    | `.`                 | Docker build context path.                           |
| `docker-build-args` |                     | Newline-separated build args (e.g. `ARG1=val1`).     |

### Deploy (optional)

| Input                 | Default                        | Description                                                  |
| --------------------- | ------------------------------ | ------------------------------------------------------------ |
| `image-credentials`   |                                | Name of the image pull secret set in Pipecat Cloud.          |
| `secret-set`          |                                | Name of the secret set for runtime secrets.                  |
| `region`              |                                | Deployment region. Uses the organization default if omitted. |
| `min-agents`          | `0`                            | Minimum agents to keep warm (0–50).                          |
| `max-agents`          | `10`                           | Maximum concurrent agents (1–50).                            |
| `agent-profile`       |                                | Agent profile name.                                          |
| `enable-managed-keys` | `false`                        | Enable managed keys.                                         |
| `wait-for-ready`      | `true`                         | Poll until the deployment is ready.                          |
| `wait-timeout`        | `90`                           | Max seconds to wait for deployment readiness.                |
| `api-url`             | `https://api.pipecat.daily.co` | Override the Pipecat Cloud API base URL.                     |

## Outputs

| Output         | Description                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| `image`        | The full image reference that was deployed (e.g. `ghcr.io/org/bot:abc123`). |
| `service-name` | The deployed service/agent name.                                            |

## Examples

### Build with custom Dockerfile and build args

```yaml
- name: Deploy to Pipecat Cloud
  uses: pipecat-ai/pipecat-cloud-deploy-action@v1
  with:
    api-key: ${{ secrets.PIPECAT_API_KEY }}
    agent-name: my-agent
    build: true
    image: ghcr.io/my-org/my-bot
    tag: ${{ github.ref_name }}-${{ github.sha }}
    dockerfile: docker/Dockerfile.prod
    docker-context: .
    docker-build-args: |
      NODE_ENV=production
      VERSION=${{ github.sha }}
    registry-username: ${{ github.actor }}
    registry-password: ${{ secrets.GITHUB_TOKEN }}
    secret-set: prod-secrets
    region: us-east-1
    min-agents: 1
    max-agents: 5
```

### Deploy without waiting for readiness

```yaml
- name: Deploy to Pipecat Cloud
  uses: pipecat-ai/pipecat-cloud-deploy-action@v1
  with:
    api-key: ${{ secrets.PIPECAT_API_KEY }}
    agent-name: my-agent
    image: ghcr.io/my-org/my-bot:latest
    wait-for-ready: false
```

### Use outputs in a subsequent step

```yaml
- name: Deploy
  id: deploy
  uses: pipecat-ai/pipecat-cloud-deploy-action@v1
  with:
    api-key: ${{ secrets.PIPECAT_API_KEY }}
    agent-name: my-agent
    image: ghcr.io/my-org/my-bot:v1.0.0

- name: Print deploy info
  run: |
    echo "Deployed image: ${{ steps.deploy.outputs.image }}"
    echo "Service name: ${{ steps.deploy.outputs.service-name }}"
```

## Setup

1. **Create a Pipecat Cloud Private API key** in the [Pipecat Cloud dashboard](https://console.pipecat.daily.co). Make sure to select **Private** (not Public) when creating the key.
2. **Add the API key as a GitHub secret** named `PIPECAT_API_KEY` (or any name you prefer) in your repository settings under _Settings > Secrets and variables > Actions_.
3. **Add the action** to your workflow file (see examples above).

## License

BSD 2-Clause License. See [LICENSE](LICENSE) for details.
