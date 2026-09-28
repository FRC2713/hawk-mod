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
nothing else changes. So the only long-term copy is the GitHub secret in step
6, which GitHub will never show again once saved. Delete the downloaded file
once it's there, and delete any laptop key you tested with — in the console
too, not only the file.

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

hawk-mod needs two values: the key, and the sheet's ID. The sheet ID is the long
part of its URL: `https://docs.google.com/spreadsheets/d/`**`173wwf6y…cBjo`**`/edit`.

**In production** nothing is put on the server by hand. hawk_suite's Deploy
workflow renders the server's `.env` from GitHub, so both values go into
[hawk_suite's settings](https://github.com/FRC2713/hawk_suite/settings/secrets/actions)
— the same place hawk-bot's Google key lives:

1. Turn the key into one line of base64, on the Mac where it downloaded:

   ```bash
   base64 -i ~/Downloads/hawk-mod-XXXXXX.json | tr -d '\n' | pbcopy
   ```

   That copies it to the clipboard without showing it.

2. **Secrets → New repository secret**: name
   `HAWK_MOD_GOOGLE_SERVICE_ACCOUNT_KEY_BASE64`, paste, save. Then delete the
   downloaded file.
3. **Variables → New repository variable**: name `LIFECYCLE_SHEET_ID`, value
   the sheet ID. It is not a secret; the sheet is useless without access.
4. Run **Actions → Deploy → Run workflow**, and approve it.

**From a laptop checkout**, for testing, point at the key file instead:

```bash
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=~/secrets/hawk-mod-google.json LIFECYCLE_SHEET_ID=173wwf6yNjvHQY_Vw--9MQzNb_1Irk_I2lyBe3whcBjo npm run cli -- lifecycle plan
```

### 7. Check it

In Slack, `/hawkmod lifecycle plan` (from a laptop, `npm run cli -- lifecycle
plan`). It changes nothing, anywhere. Expect:

- **"Google is not configured"** if the secret did not reach the container —
  check the name, and that the deploy ran after it was set.
- **A header error** if a tab or column has been renamed. It names the column,
  and nothing is read until it's fixed.
- **A 403** if step 5 did not take.
- Otherwise, counts of people and of each computed group, the mentors not
  cleared (so not eligible for Slack) and why, and a list of sheet problems by Person ID. The
  sample people P0001–P0003 are ignored and reported until they're deleted.

The output names Person IDs and counts only. The CLI's `--members` adds each
group's addresses; most of those belong to minors, so keep that output to
yourself. Slack never offers it.

## Part 2 — manage groups (step 4 onwards)

Done for Red Hawk on 2026-09-28. Four parts, in this order.

1. **Enable the Admin SDK API** in the same Google Cloud project as the
   service account (search "Admin SDK API" → **Enable**).
2. **Domain-wide delegation.** Admin console → **Security → Access and data
   control → API controls → Manage Domain Wide Delegation → Add new**, with
   the service account's numeric **Unique ID** (Cloud console → IAM & Admin →
   Service Accounts → the account → Details) and, for step 4, **only** these
   two scopes, comma-separated:
   - `https://www.googleapis.com/auth/admin.directory.group.readonly` — read
     groups
   - `https://www.googleapis.com/auth/admin.directory.group.member` — read and
     change group members

   Not the broad `admin.directory.group`, which could also create and delete
   groups. Later steps add their own scopes, each when it is first used
   (decided 2026-09-28), so the delegation never grants more than hawk-mod
   does:
   - `https://www.googleapis.com/auth/admin.directory.user.readonly` (step 6)
     — check each RHR Email is a real account; `admin.directory.user` (step 7)
     to suspend or restore one after an admin approves it
   - `https://www.googleapis.com/auth/admin.directory.rolemanagement.readonly`
     (step 8) — to report who holds Groups Admin and Help Desk Admin.
     Read-only: only a Super Admin can grant those roles, so hawk-mod reports
     and a person acts

3. **An account to act as, with a narrow role.** hawk-mod acts as
   `hawk-mod@redhawkrobotics.org`, so every change it makes appears in the
   Admin audit log under that name. (`GOOGLE_ADMIN_SUBJECT` and
   `GOOGLE_DOMAIN` override the defaults; neither needs setting.) A Super
   Admin creates a **custom admin role** — Admin console → **Account → Admin
   roles → Create new role**, named `hawk-mod group membership` — with
   **Groups → Read** and **Groups → Update** and nothing else, then assigns
   it to `hawk-mod@`. Not the prebuilt Groups Admin, which can also create and
   delete groups. Groups → Update alone could also rename a group, but the
   delegated scopes in part 2 only reach membership, so together they come to
   "read groups, change members".
4. **External members.** Admin console → **Apps → Google Workspace → Groups
   for Business → Sharing settings → Group owners can allow external
   members**, then, per group (**Directory → Groups →** the group **→ Access
   settings**), allow members outside the organization on `grp-students`,
   `grp-student-leads`, `grp-all-team`, `grp-volunteers`, `grp-alumni` and
   `grp-parents`. **Leave it off** for `grp-mentors`, `grp-mentor-leads` and
   `grp-ra`: mentor groups are domain accounts only.

hawk-mod never creates a group. All nine must exist, as `grp-…@` the domain;
`/hawkmod lifecycle groups` says so if one does not.

### Checking it

`/hawkmod lifecycle groups` in Slack reads every group as `hawk-mod@` and
changes nothing. What it can say:

- **"refused to let the service account act as hawk-mod@"** — part 2: the
  client ID or the two scopes.
- **"refused to read grp-…"** — part 3: the role is missing Groups → Read, or
  is not assigned to `hawk-mod@`.
- **"does not exist in Google"** for a group — create it by hand.
- Otherwise, per group, who would join, who would leave on their own (a lead
  or RA flag turned off), and who is held for a click, by Person ID.
