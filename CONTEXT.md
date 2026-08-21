# hawk-mod

Youth-protection auditing for a FIRST team's Slack workspace: it records
adult–student direct messages so a human can review them, because Slack cannot
prevent those messages below Enterprise Grid.

This glossary exists because several words in this domain look like synonyms and
are not. Confusing any pair of them ends someone's monitoring quietly, which is
the failure this project is built to avoid.

## People

**Person**:
Someone the roster knows about, identified by their Slack account.
_Avoid_: User, member, account

**Student**:
A person the roster records as a minor, whose direct messages with adults are
recorded. See **Declared** vs **Monitored** — the word alone is ambiguous.
_Avoid_: Kid, child, minor

**Adult**:
Any person on the roster who is not a student, a district observer included.
Seniority is never an exemption.
_Avoid_: Mentor, coach, grown-up, leader

**Screened adult**:
An adult with current Youth Protection Screening, Youth Protection Training, and
CORI on file. Only screened adults count toward the two-adult rule.

**Administrator**:
Someone Slack records as a Workspace Owner or Admin. It is not a roster role and
is never stored — the roster says who is monitored, never who is in charge.
_Avoid_: Lead coach, admin role, superuser

## Declaration vs monitoring

These two are the distinction most easily lost, and the one that matters most.

**Declared**:
Present in the Slack user group that names a role — `@students` or `@adults`.
Cheap, reversible, and edited by hand in Slack or through hawk-mod. A
declaration is a statement of intent, not a fact about monitoring.
_Avoid_: Enrolled, rostered, assigned

**Monitored**:
Carried on the roster with a role and marked active. Sticky by design: gained
automatically when someone is declared, and lost only by an explicit,
attributed act. Removing a declaration never removes monitoring.
_Avoid_: Tracked, watched, covered

**Active**:
The state of a person whose monitoring is in force. The opposite is
**deactivated** — a person the roster remembers but no longer monitors.

**Deactivation**:
The deliberate act of ending a person's monitoring. The only operation in
hawk-mod that makes it see less, and therefore the only one that always names
who performed it and why.
_Avoid_: Removal, deletion, archiving, offboarding

**Reactivation**:
Restoring monitoring to a deactivated person. Happens automatically when they
are declared again, because gaining protection never needs permission.

## Enrollment

**Enrollment**:
An adult's own authorization letting hawk-mod read their direct messages. It is
what makes DMs visible at all, and it is granted by that adult, never on their
behalf. Students may never enroll.
_Avoid_: Onboarding, signup, opting in, installation

**Coverage**:
The proportion of adults requiring enrollment who have enrolled. An unenrolled
adult is a gap, and a gap is a finding rather than a silence.

**Group-editing authorization**:
An administrator's separate authorization letting hawk-mod edit Slack user
groups as them. Distinct from enrollment in purpose, lifetime, and consent, and
held separately so that neither can revoke the other.

## Conversations

**Conversation**:
A Slack direct message or group direct message that hawk-mod has classified.
Classification depends only on who is present, never on what was said.

**Verdict**:
What the rules conclude about a conversation from its participants alone.

**Two-adult rule**:
The requirement that a student's conversation include at least two screened
adults. Unknown accounts never satisfy it.

**Remedy**:
Moving a one-to-one conversation into a channel or adding a second adult. A
remedy acknowledges a finding; it never resolves one, because the one-to-one
still happened.
_Avoid_: Fix, resolution, correction

## Findings

**Finding**:
A recorded policy problem. Findings name people and conversations, never
message content.
_Avoid_: Alert, violation, issue, incident

**Condition finding**:
A finding describing something currently true, such as lapsed screening.
Re-detecting one is not news.

**Occurrence finding**:
A finding describing something that happened, such as a one-to-one message. Only
a newer event can repeat it.

**Dedupe key**:
The identity of a problem across sweeps. It is what separates an alert channel
someone reads from one nobody does.

**Guidance**:
An advisory note sent privately to the adults in a conversation that raised a
finding. It never reaches the student, and it never replaces the finding.

## Reconciliation

**Sweep**:
The scheduled pass that re-checks conditions and closes what it owns.

**Backfill**:
The hourly re-walk of enrolled adults' message history, catching what predates
enrollment or was missed while the process was down.

**Plan**:
The set of additions and removals that would bring a user group to an intended
membership. A plan is inspectable before it is applied, and is refused outright
when it would remove too much of a group at once.
_Avoid_: Diff, changeset, patch

**Drift**:
A disagreement between what Slack declares and what the roster monitors. Drift
is reported, never silently reconciled in the direction that reduces monitoring.
