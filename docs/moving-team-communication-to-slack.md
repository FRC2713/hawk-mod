# Moving Team Communication to Slack

The source document for this repo: the team's written plan for running on
Slack, and the policy analysis behind it. hawk-mod implements §4 and §6.
[policy-mapping.md](policy-mapping.md) maps each control below to the code that
carries it, records which ones are deliberately manual, and notes two places
where later reading of the FIRST rules corrected what §3 and §7 say here.

Two caveats the original carries in a note to the board rather than in the text:
the nonprofit-pricing/educator-status tension in §5 is unresolved and worth
re-checking at renewal, and clause 1 quoted in §8 is typical language for that
policy family, **not confirmed Melrose text** — the district PDF has not been
read cleanly. If clause 1 turns out not to be in IJNDD, that whole conditional
goes away.

---

**Summary:** Slack is workable for our team, legally and under FIRST policy, but only with a specific setup. This post lays out what's required, what it costs, and the one open question we need the district to answer.

---

- Slack allows students **13+** under its education terms, but only with documented **parental consent collected before students sign up**.
- Our **501(c)(3) will own the workspace**, not the school. This is what lets non-employee mentors participate — the reason we can't just use Google Classroom.
- We need the **Business+ plan** (~$2.25/user/month at the nonprofit discount) so that DMs are auditable.
- **Direct messages between mentors and students cannot be technically blocked.** We manage this with policy and real audits, not software.
- **One open item:** one of our mentors is an MPS employee and is bound by district policy IJNDD. We need written approval from the principal before launch.

---

## 1. Why not the school's tools

Google Classroom and district Google Workspace can't hold non-employee adults. Most of our mentors aren't MPS employees, so the district's platform structurally cannot work for us. That's what makes an outside tool necessary rather than merely convenient.

## 2. Slack's terms actually permit this

Slack's general User Terms set a 16+ age floor, which would exclude most of our underclassmen. But Slack's **Customer-Specific Supplement, Section IV ("Education Professional Customers")** overrides it:

> "If Customer is a school or educator in the United States and wants its students, who are over the age of 13, to use the Services, Customer is responsible for complying with the U.S. Family Educational Rights and Privacy Act ("FERPA"). This means Customer must notify those students' parents/guardians of the personally identifiable information that it will collect and share with us and obtain parental/guardian consent before its students sign up or use the Services... Customer must keep all consents on file and provide them to us if we request them."

**What this obligates us to do:**

- Collect signed parental consent for every student **before** they get an account
- Disclose what Slack collects: name, email, message content, files, timestamps, IP address
- Provide parents a copy of Slack's Privacy Policy with the consent form
- Keep consents on file permanently and produce them if Slack asks
- Re-collect annually

This is not a formality. It is the condition on which our students are allowed to use the product at all.

## 3. FIRST Youth Protection Program

FIRST doesn't ban Slack, but its rules are structural:

- Two YPP-screened Lead Coaches minimum
- Mentors should not initiate contact with students except about FIRST activities
- Direct messaging between mentors and students on unofficial platforms is **explicitly discouraged**
- Written communications with a student should ordinarily be copied to a parent or a second adult

## 4. The DM problem — stated plainly

**Slack does not allow disabling internal direct messages below the Enterprise Grid tier**, which is enterprise-sales priced and out of reach. Information barriers, the only feature that blocks DMs between groups, is Grid-only.

So any mentor can DM any student from day one. We cannot prevent this. We can only detect it.

**Our controls:**

1. Signed mentor agreement: no 1:1 mentor–student DMs, ever. Anything that starts in a DM moves to a channel or gets a second adult added.
2. Two screened adults in every channel students are in.
3. Students and parents are told up front, in the consent form, that DMs are exportable and subject to audit.
4. **We actually run a quarterly export and spot-check it.** An audit right we never exercise is worth nothing.

This is a real residual risk. We're substituting policy and after-the-fact auditing for a technical control Slack won't sell us. That's a defensible tradeoff for a volunteer organization, but the board should record the decision in the minutes rather than leaving it as something the coach decided.

## 5. Cost

|               | List (annual) | Nonprofit price              | DM/private channel export?                 |
| ------------- | ------------- | ---------------------------- | ------------------------------------------ |
| Pro           | $7.25/user/mo | **Free** (≤250 members)      | No — public channels only                  |
| **Business+** | $15/user/mo   | **85% off → ~$2.25/user/mo** | **Yes** — Corporate Export, by application |

Roughly **$27 per person per year** on Business+:

- 25 accounts → ~$675/yr
- 40 accounts → ~$1,080/yr
- 60 accounts → ~$1,620/yr

Free Pro is tempting, but it gives up the export capability that our entire DM mitigation plan depends on. On Pro, if a parent or the district asks us to produce a mentor–student DM thread, **we cannot**. Recommend Business+ as a budget line item — comparable to a couple of spare motors.

Apply at `my.slack.com/nonprofit` with our legal name, address, website, mission description, and IRS determination letter. Verification runs through TechSoup, ~3 days. **Then apply separately for Corporate Export** — it's an application, not a toggle, and we don't want to be filing it the week we need it.

## 6. Workspace configuration

- **Retention set to "keep everything."** Never auto-delete. Default deletion is the worst posture if an allegation ever surfaces.
- Disable Slack Connect external DMs (Workspace Settings → Permissions)
- Workspace invites restricted to Owners/Admins
- Two Workspace Owners minimum, both screened adults, never a student
- Real names enforced; no pseudonymous accounts
- Turn off huddles, or accept that huddles are unrecorded 1:1 voice — same problem as DMs, and easy to forget

## 7. Screening

Independent of everything above, and required regardless of platform:

- FIRST YPP screening for both Lead Coaches; Mentor Ready training (includes Youth Protection Training and Data Privacy for Mentors) for all mentors
- Under **M.G.L. c. 71 §38R** and **603 CMR 51.00**, CORI **and** national fingerprint checks every three years for any volunteer with direct and unmonitored contact with students. Run through the district HR office.

Keep training completions filed with the consent forms.

## 8. Open item: our MPS-employee mentor

Melrose School Committee policy **IJNDD — Policy on Use of Social Media Sites** (Section I of the district policy manual) binds any MPS employee personally, as a condition of employment. It prohibits "improper fraternization with students using any social media... chat rooms, texts... or other digital means."

Policies in this family typically also contain:

1. _"All electronic contacts with students should be through the district's e-mail, computer and telephone systems, except in emergency situations."_ — **If Melrose's version contains this, our employee-mentor cannot use Slack with students at all**, no matter who owns the workspace. This clause decides the question.
2. _"Team, class, or student organization pages, accounts, or groups will be created only in conjunction with the teacher, coach or faculty advisor. All groups must include the appropriate administrator as a member."_ — This is our remedy.

**Proposed actions:**

- Read IJNDD in full and check for clause 1
- Get **written approval** from the principal or superintendent before launch — email is fine, but in writing, filed with the consents
- **Add an MPS administrator to the workspace as a member.** This satisfies clause 2 on its own terms and turns our Slack from "an outside platform an employee uses with students" into "a channel the district can see." One seat, ~$27/yr — the cheapest risk reduction in this entire plan.
- If clause 1 applies and no exception is granted, that mentor stays in mentors-only channels

This binds one person, not the booster club or our other mentors. It's a one-person problem with a one-person solution and doesn't threaten the plan.

---

## Launch checklist

- [ ] Board votes to approve, records the DM-risk tradeoff in the minutes
- [ ] Read IJNDD; send written approval request to the principal
- [ ] Apply for Slack for Nonprofits (booster club, not the school)
- [ ] Upgrade to Business+; apply for Corporate Export
- [ ] Configure workspace per section 6
- [ ] Draft and circulate parental consent form + mentor conduct agreement
- [ ] **Collect all signed consents — before any student account is created**
- [ ] Confirm CORI/fingerprints and YPP screening current for all mentors
- [ ] Add an MPS administrator to the workspace
- [ ] Launch; calendar the first quarterly audit
