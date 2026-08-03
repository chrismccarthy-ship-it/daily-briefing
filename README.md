# Daily Briefing

A **"Start Your Day"** dashboard for Salesforce Sales Reps and CSMs. One Apex class gathers
the running user's open work — at‑risk accounts, tasks, cases, overdue opportunities, pending
applications, approvals, and (optionally) Slack mentions — and surfaces it as a single,
interactive Lightning Web Component. An AI panel (Einstein / Agentforce) summarizes the day and
answers free‑form questions grounded **only** on that user's data.

> Design goal: **minimal clicks.** Drop one component on the Home page and the rep's whole day is
> laid out the moment they log in.

---

## What's in this repo

```
force-app/main/default/
├── classes/
│   ├── DailyBriefingController.cls        # single entry point: gather → build JSON → AI/prompt
│   └── DailyBriefingControllerTest.cls    # deployment coverage
├── lwc/
│   ├── dailyBriefing/                     # the dashboard (native SLDS UI, filters, row actions)
│   ├── assignOwnerModal/                  # reassign-owner modal (lightning/modal)
│   └── flowLauncherModal/                 # launches a screen flow in a modal
├── flows/
│   └── Daily_Briefing.flow-meta.xml       # 2-element screen flow (Apex action → display screen)
├── objects/
│   └── Application__c/                     # custom object: credit/loan applications + 8 fields + list view
├── flexipages/
│   └── Daily_Briefing_Home.flexipage-meta.xml   # App/Home page hosting the component
├── layouts/                               # Account & Contact layouts (add the Applications related list)
├── permissionsets/
│   ├── Application_Access.permissionset-meta.xml     # CRUD + FLS on Application__c
│   └── Slack_Briefing_Access.permissionset-meta.xml  # access to the Slack external-credential principal
└── externalCredentials/
    └── Slack.externalCredential-meta.xml  # Slack auth scaffold (disabled by default)

docs/                                      # setup guides + flat reference copies of the components
├── SETUP-GUIDE.md                         # the three delivery options (Flow / LWC / Agentforce), in depth
└── SLACK-SETUP.md                         # how to finish the optional Slack integration
```

---

## Architecture

`DailyBriefingController` is the single brain. It exposes several entry points:

| Method | Type | Used by |
|---|---|---|
| `getBriefingData(scope)` | `@AuraEnabled` | LWC — returns the raw JSON the dashboard renders itself |
| `getAISummary(scope)` | `@AuraEnabled` | LWC — 2–3 sentence executive summary via `ConnectApi.EinsteinLLM` |
| `runPrompt(prompt, scope)` | `@AuraEnabled` | LWC — free-form Q&A grounded only on the user's data |
| `initiateSlackSwarm(caseId)` | `@AuraEnabled` | LWC — creates a `swarm-<case#>` Slack channel (simulated until Slack is enabled) |
| `getBriefing(request)` | `@InvocableMethod` | Flow / Agentforce — returns formatted HTML from a Prompt Template |
| `getBriefingHtml(scope)` | `@AuraEnabled` | alternate HTML path |

**Scope** is `owner` (accounts the user owns) or `engagement` (owns *or* has an open opp/case on).

The dashboard LWC (`dailyBriefing`) renders its own SLDS UI with per‑section search, typed
filters, column sort, collapse, business‑mode (All / Sales / Service), configurable section
colors, and row actions (view/edit/delete, reassign owner, approve application, start Slack
swarm, escalate to Teams). All section visibility, colors, and record caps are **App Builder
design properties** — no code change needed to reconfigure.

---

## Dependencies & prerequisites

The app leans on org features and fields that are **not** all contained in this repo. Verify these
in your target org before (or as part of) deployment:

| Dependency | Needed for | In this repo? | Notes |
|---|---|---|---|
| **`Account.SDO_AI_AccountHealth__c`** (picklist) | "Accounts That Need Attention" section | ❌ | Referenced directly in Apex — **class won't compile without it.** Values used: `At Risk`, `Critical`, `Churned`. |
| **`Account.SDO_CPQ_Churn_Risk__c`** (checkbox) | churn‑risk flag on accounts | ❌ | Standard in many SDO demo orgs. |
| **Prompt Template `Daily_Briefing_Prompt`** (Flex) | Flow / HTML briefing (`getBriefing`, `callPromptTemplate`) | ❌ | Create in Prompt Builder; input variable `userInstructions`. See `docs/SETUP-GUIDE.md`. Not required for the LWC dashboard's structured view or the `getAISummary`/`runPrompt` paths. |
| **Einstein Generative AI / Prompt Builder** enabled | any AI feature | n/a | Requires an Einstein/Agentforce‑capable license. |
| **Flow `Escalation_to_Teams`** | the case‑row "Escalate to Teams" action | ❌ | On‑demand only; deploy won't fail without it, but the action errors if invoked. |
| **Named Credential `Slack`** | live Slack mentions / real swarm posts | ❌ (scaffold only) | Disabled by default (`ENABLE_SLACK = false`). See `docs/SLACK-SETUP.md`. |

---

## Deployment

Prereqs: Salesforce CLI (`sf`) and an authorized target org.

```bash
# authorize once (skip if already connected)
sf org login web -o <your-org-alias>

# deploy the app with test execution
sf project deploy start -o <your-org-alias> --test-level RunLocalTests
```

**Before deploying, address the two known issues** (see *Deployment notes* below), or the deploy
will fail validation:

1. Create `Account.SDO_AI_AccountHealth__c` (picklist) if the org lacks it — otherwise the Apex
   class, and the Flow + LWC that reference it, all fail.
2. The two **Contact layouts** were captured from a different org and reference a
   `Financial_Account__c` related list whose fields don't exist everywhere — deploy only the
   layouts whose related‑list fields resolve in your org.

### Post‑deploy setup
1. **Assign permission sets** — `Application Access` to anyone who uses the dashboard;
   `Slack Briefing Access` only if you enable Slack.
2. **Place the component** — App Builder → Home (or App) page → drop **Daily Briefing**, or use
   the included `Daily_Briefing_Home` FlexiPage. Configure the design properties (scope, colors,
   which sections show, max rows).
3. **(Optional) Prompt Template** — create `Daily_Briefing_Prompt` to light up the HTML/Flow and
   Agentforce paths (`docs/SETUP-GUIDE.md`).
4. **(Optional) Slack** — follow `docs/SLACK-SETUP.md`, then flip `ENABLE_SLACK = true` and redeploy the class.

---

## Deployment notes (this repo, as verified against an SDO org)

- **`Account.SDO_AI_AccountHealth__c` is the single hard blocker.** It is referenced statically in
  Apex, so its absence fails compilation and cascades to the Flow and LWC. Create the picklist
  (values at least `At Risk`, `Critical`, `Churned`) or remove the account‑health dependency.
- **Contact layouts** (`Contact-Contact Layout`, `Contact-SDO - Contact`) reference
  `Financial_Account__c.Opened_Date__c` / `Account_Holder__c`, which are foreign to this org and
  fail validation. The Account layouts validate cleanly. Deploy layouts selectively.
- A stray, malformed LWC artifact named `creditScoreGauge` (a CSS file with no bundle) was present
  and is unreferenced; it must be excluded or it breaks LWC compilation. It has been removed from
  the deployable set.
- The full `Admin.profile` (273 user‑permissions, no field/layout grants) is not required by the
  app and is risky to deploy (any permission whose feature is disabled fails the whole deploy);
  exclude it.

---

## Testing

`DailyBriefingControllerTest` covers the gather‑and‑build path, both scopes, the invocable entry
point, and graceful degradation when the Einstein callout is unavailable in test context.

```bash
sf apex run test -o <your-org-alias> --class-names DailyBriefingControllerTest --result-format human
```

> The test class inserts an Account with `SDO_AI_AccountHealth__c`, so it also requires that field
> to exist in the org.
