# Windows Setup

## Requirements

Install and start Docker Desktop with Linux containers. Docker's Windows
requirements and WSL setup are documented in its
[official installation guide](https://docs.docker.com/desktop/setup/install/windows-install/).
No separate Node.js or PostgreSQL installation is required for this application.

Extract the supplied source package into a local directory. Open PowerShell in
the directory containing `docker-compose.yml` and `Dockerfile`.

## Provider-Free Trial

Create a local `.env` file with:

```dotenv
DEMO_MODE=true
OPENAI_API_KEY=
```

Run:

```powershell
docker compose up --build -d --wait
docker compose ps
```

Open the Interview application at http://localhost:5273, Monitoring at
http://localhost:5274 and Evaluation Studio at http://localhost:5275. Select
English and Text mode for the deterministic trial.

## Provider Operation

To use Voice or real model evaluation, set `DEMO_MODE=false` and enter your API
key in `.env`. Re-run the same Compose command. Voice requires a working
microphone permission and does not fall back to another mode when the key is
missing. Provider calls may incur charges.

## Troubleshooting

```powershell
docker compose ps
docker compose logs --tail 100 backend
docker compose logs --tail 100 migrations
```

Start Docker Desktop if the Docker engine cannot be reached. The commands above
are PowerShell commands and do not require `bash` or the GitHub CLI. A browser
reload does not rebuild the application.

Normal rebuilding retains the database volume. Do not remove volumes when you
need the interviews stored on this computer.
