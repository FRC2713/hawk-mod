# Google setup for the lifecycle sync

What a Google Workspace super admin does, once, so hawk-mod can read the
**RHR User Lifecycle Management DB** sheet and, later, manage Google Groups.
Nothing here is needed for anything hawk-mod did before the lifecycle sync; a
host with none of it keeps working exactly as it did.

There are two parts. **Part 1 is all that step 0 and step 1 need** (read the
sheet, write back Slack IDs). Part 2 is for step 4 onwards, when hawk-mod starts
changing Google Groups; there's no need to do it yet.

The scope and the reasons behind it are in
[`lifecycle-sync.md`](lifecycle-sync.md).

## Part 1 — read the sheet

### 1. A Google Cloud project

At [console.cloud.google.com](https://console.cloud.google.com), signed in as a
`@redhawkrobotics.org` admin, create a project called `hawk-mod` under the
`redhawkrobotics.org` organization. It costs nothing: the Sheets and Admin APIs
are free at this volume.

### 2. Turn on the Sheets API

In that project: **APIs & Services → Library → Google Sheets API → Enable.**

### 3. A service account

**IAM & Admin → Service Accounts → Create service account.** Name it
`hawk-mod-lifecycle`. Grant it **no** project roles — its access comes from
being shared on the sheet, not from the project.

Note its email address, which looks like
`hawk-mod-lifecycle@hawk-mod-XXXXXX.iam.gserviceaccount.com`.

### 4. A key for it

On the service account: **Keys → Add key → Create new key → JSON.** A file
downloads.

If Google says **service account key creation is disabled**, that's an
organization policy, on by default for organizations created since 2024. There
are **two** policies by that name, a legacy one
(`iam.disableServiceAccountKeyCreation`) and a managed one
(`iam.managed.disableServiceAccountKeyCreation`), and either one blocks the key.
The error dialog names the one that fired. To allow keys for this one project,
with the `hawk-mod` project selected in the picker:

1. **IAM & Admin → Organization Policies → Disable service account key
   creation → Manage policy**: _Override parent's policy_, one rule, _Not
   enforced_, **Set policy**.
2. That page has a banner saying the legacy constraint is active. Click **View
   legacy constraint** and do the same there: _Override parent's policy_, one
   rule, enforcement _Off_, **Set policy**. Overriding the managed policy does
   not switch the legacy one off.
3. Allow a few minutes for the change to apply before trying the key again.

This needs the Organization Policy Administrator role, which a super admin can
grant themselves under **IAM** at the organization level. Leave the
organization-wide policies alone.

**Keep as few copies as possible, and no backup.** Whoever has the key can read
the sheet (every minor's name, school email and form dates), and after Part 2 it
can act as a Google admin. Unlike `TOKEN_ENCRYPTION_KEY`, it is replaceable: if
it's lost, create a new key on the same service account and delete the old one;
nothing else changes. So the only long-term copy is the one on the hawk-mod
host (`chmod 600`). Delete any laptop copy you tested with, and delete that key
in the console.

Don't keep it in a shared Drive folder, even a restricted one, and especially
not beside the lifecycle sheet. Everyone who can open the folder would hold an
admin credential, and a downloaded copy keeps working after their folder access
ends. If a spare copy is really wanted, use a password-manager vault limited to
the one or two people who would rotate it. If the key is ever exposed, delete it
in the console; it stops working at once.

### 5. Share the sheet with the service account

Open the sheet → **Share** → add the service account's email as **Editor**
(Editor, not Viewer, because step 1 writes Slack User IDs back). Untick
"Notify people"; nobody reads that inbox.

Share the **sheet only**, not the whole shared drive — hawk-mod has no business
with anything else in it.

If Drive refuses because the address is outside `redhawkrobotics.org`, the
Workspace's external sharing settings are blocking it: **Admin console → Apps →
Google Workspace → Drive and Docs → Sharing settings**, and allow sharing
outside the organization for the shared drive's organizational unit (or ask
before loosening it, and we'll switch the sheet read to impersonation from Part
2 instead).

### 6. Tell hawk-mod where things are

The sheet ID is the long part of its URL:
`https://docs.google.com/spreadsheets/d/`**`173wwf6y…cBjo`**`/edit`.

To try it from a laptop checkout, with the key file somewhere outside the repo:

```bash
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=~/secrets/hawk-mod-google.json LIFECYCLE_SHEET_ID=173wwf6yNjvHQY_Vw--9MQzNb_1Irk_I2lyBe3whcBjo npm run cli -- lifecycle plan
```

On the host, copy the key next to the stack (`chmod 600`), then in `.env`:

```bash
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/run/secrets/google-key.json
LIFECYCLE_SHEET_ID=173wwf6yNjvHQY_Vw--9MQzNb_1Irk_I2lyBe3whcBjo
```

and uncomment the key's volume line in `docker-compose.yml`.

### 7. Check it

`lifecycle plan` changes nothing, anywhere. Expect:

- **A header error** if a tab or column has been renamed. It names the column,
  and nothing is read until it's fixed.
- **A 403** if step 5 did not take.
- Otherwise, counts of people and of each computed group, the mentors kept out
  of `grp-all-team` and why, and a list of sheet problems by Person ID. The
  sample people P0001–P0003 are ignored and reported until they're deleted.

The default output names Person IDs and counts only, so it's safe to paste into
a channel. `--members` adds each group's addresses; most of those belong to
minors, so keep that output to yourself.

## Part 2 — manage groups (step 4 onwards; not yet)

Recorded here so the whole picture is in one place.

1. **Enable the Admin SDK API** in the same project.
2. **Domain-wide delegation.** Admin console → **Security → Access and data
   control → API controls → Manage domain-wide delegation → Add new**, with the
   service account's numeric client ID and these scopes:
   - `https://www.googleapis.com/auth/admin.directory.group` — group membership
   - `https://www.googleapis.com/auth/admin.directory.user` — read accounts,
     and suspend or restore them after an admin approves it
   - `https://www.googleapis.com/auth/admin.directory.rolemanagement` — the
     Groups Admin and Help Desk Admin roles, after approval
3. **An account to act as.** Every change hawk-mod makes appears in the Admin
   audit log as the account it impersonates. A dedicated
   `hawk-mod@redhawkrobotics.org` admin makes that log say what actually
   happened; we'll decide its exact privileges in step 4.
4. **External members.** Groups that hold students' school addresses and
   volunteers' personal ones must allow members from outside the domain:
   Admin console → **Apps → Google Workspace → Groups for Business → Sharing
   settings**, then per group.
