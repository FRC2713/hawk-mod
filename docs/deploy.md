# Deploying

One container, one volume, behind a reverse proxy. One requirement is easy to
get wrong, so it goes first.

## It has to be publicly reachable

Slack delivers events and completes the OAuth redirect from its own servers, so
`PUBLIC_URL` must be:

- a hostname on the team's domain, publicly resolvable,
- served over real HTTPS (Slack will not post to plain HTTP),
- reachable from the internet on 443.

A private, VPN-only, or self-signed setup will not work, no matter how
convenient it is for the people running it.

## 1. DNS and TLS

Point an A record for something like `hawk-mod.<team-domain>` at the server's
public IP, then terminate TLS in front of the container. With Caddy that is:

```
hawk-mod.example.org {
	reverse_proxy hawk-mod:3000
}
```

The app joins a shared `edge` network and publishes no ports of its own, so the
proxy reaches it by container name. Create the network once if it does not
exist:

```bash
docker network create edge
```

Any proxy works — Caddy, nginx, Traefik. All hawk-mod needs is HTTPS in front
and a route to port 3000 in the container.

## 2. Secrets

On the host, in the stack directory:

```bash
cp .env.example .env
```

Fill in the four Slack values from the app's Basic Information page, then
generate the two secrets:

```bash
printf 'SLACK_STATE_SECRET=%s\nTOKEN_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" >> .env
```

Set `PUBLIC_URL` to the hostname above and `ALERT_CHANNEL_ID` to the private
findings channel's ID (the `C…` value, not the name).

**`TOKEN_ENCRYPTION_KEY` is not recoverable.** Lose it and every adult has to
re-authorize; leak it and the volume alone is enough to read their DMs. Keep a
copy wherever the team's other credentials live, not only on the host.

## 3. Run it

```bash
docker compose up -d
```

Or pull the image built by CI instead of building on the host — edit the
`image:` line in `docker-compose.yml` and:

```bash
docker compose pull && docker compose up -d
```

Check it came up:

```bash
docker compose ps && docker compose logs --tail=20
```

`docker compose ps` should show `healthy` within about 30 seconds. The health
endpoint reports whether the app has been installed yet:

```bash
curl -s https://hawk-mod.example.org/health
```

`{"status":"ok","installed":false,"enrolledAdults":0}` is the expected state
before setup — running and waiting.

## 4. Set up the workspace

1. A Lead Coach visits `https://hawk-mod.example.org/slack/install`.
2. Invite the bot to the private findings channel.
3. Import the roster and consents (see the README).
4. Send every adult the same install URL, and watch `/hawkmod status` until
   coverage reads N/N.

## Upgrades

Migrations are applied on boot, so an upgrade is:

```bash
docker compose pull && docker compose up -d
```

Never hand-edit a migration that has already run on this host.

## Backups

The volume holds parental-consent records and, at `LOG_MODE=full`, the message
text of students' DMs. Treat it accordingly.

```bash
docker compose exec hawk-mod node -e "const D=require('better-sqlite3');new D(process.env.DATA_DIR+'/hawk-mod.db').backup('/data/backup.db').then(()=>process.exit(0))"
```

Use SQLite's backup API rather than copying the file — a plain `cp` of a WAL
database mid-write produces a corrupt copy. Then pull it off the host and
encrypt it at rest. A quarterly cadence matching the audit is the minimum; the
whole point of this system is being able to produce a conversation months
later.

## Data handling on a public server

The database holds minors' message content on a rented machine:

- Restrict SSH to keys, and keep the host patched. Anyone with root on the
  Linode can read the volume.
- Do not bind-mount the data directory somewhere world-readable; the named
  volume under `/var/lib/docker/volumes` with default permissions is fine, and
  the container runs as a non-root user that owns it.
- `LOG_MODE=metadata` records who/when/how-many without message text and still
  detects every policy violation. If the team is uneasy about storing minors'
  message content on a rented host, that is the setting to change — the cost is
  that an investigation has to fall back to a Corporate Export.
- Rotate `TOKEN_ENCRYPTION_KEY` by having adults re-enroll if the host is ever
  suspected of compromise.

## Building locally on macOS

`docker build` from an agent session can trip the macOS "would like to access
data from other apps" prompt, because Docker Desktop's credential helper
(`credsStore: desktop`) and its CLI hooks read the Docker Desktop app
container. Building with a minimal CLI config avoids it:

```bash
DOCKER_CONFIG=~/.docker-plain DOCKER_HOST=unix:///var/run/docker.sock docker build -t hawk-mod .
```

where `~/.docker-plain` contains `{"auths":{},"features":{"hooks":"false"}}`
and a `cli-plugins/docker-buildx` symlink into `/Applications/Docker.app`. This
changes nothing about Docker Desktop itself. CI builds the real image anyway.
