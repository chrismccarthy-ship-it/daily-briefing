# Daily Briefing — Setup Guide

A "Start Your Day" briefing for Sales Reps / CSMs. One Apex action gathers the user's
Tasks, Accounts, Opportunities, Cases (+ optional Alerts & Slack), sends them to a
Prompt Template, and returns formatted HTML. A 2-element Screen Flow displays it.

**Design goal: minimal clicking.** All logic lives in Apex, so the Flow is just
`Apex action → display screen`. The rep opens one tab and the whole day is laid out.

---

## Files in this folder
| File | What it is |
|---|---|
| `DailyBriefingController.cls` (+ `-meta.xml`) | The single Apex action: gather → call prompt → return HTML |
| `DailyBriefingControllerTest.cls` (+ `-meta.xml`) | Test class for deployment coverage |
| `Daily_Briefing.flow-meta.xml` | The 2-element Screen Flow |
| `../daily-briefing-prompt-harness.md` | The Prompt Template text + regression tests |

---

# OPTION 1 — Screen Flow (recommended, minimal clicks)

### Prerequisites
- **Einstein Generative AI / Prompt Builder** enabled (Setup → Einstein → turn on; your org needs a Prompt-Builder-capable license such as Einstein for Sales / Agentforce).
- Permission to create Apex, Flows, and Prompt Templates.

### Step 1 — Create the Prompt Template (once)
1. Setup → **Prompt Builder** → **New Prompt Template**.
2. Type: **Flex** (a.k.a. "Flex Template" — the freeform one that takes an input you pass in).
3. Name it so the **API Name = `Daily_Briefing_Prompt`** (this is referenced in the Apex; if you name it differently, update `callPromptTemplate` in the class).
4. Add an **input** named `userInstructions` (type: Free Text / String). This is what the prompt references as `{!$Input:userInstructions}`.
5. Paste the full prompt body from `daily-briefing-prompt-harness.md` (section 1) into the template.
6. **Save & Activate.** Use the Preview pane with the Test-1 JSON to confirm it renders.

### Step 2 — Deploy the Apex
Copy the two `.cls` (+ meta) files into your project's `force-app/main/default/classes/` and deploy:
```
sf project deploy start -d force-app/main/default/classes -o <your-org-alias>
```
(Or paste into Setup → Apex Classes → New, one class at a time.)

> If `ConnectApi.EinsteinPromptTemplateGenerationsInput` doesn't resolve in your org's
> API version, see **Appendix A** for the fallback (let the Flow call the prompt instead of Apex).

### Step 3 — Deploy the Flow
Copy `Daily_Briefing.flow-meta.xml` into `force-app/main/default/flows/` and deploy:
```
sf project deploy start -d force-app/main/default/flows -o <your-org-alias>
```
The Flow has exactly two elements:
1. **Get Daily Briefing** (Apex action → `DailyBriefingController`)
2. **My Day** screen → a Display Text component showing `{!Get_Daily_Briefing.htmlOutput}`

### Step 4 — Surface it with as few clicks as possible
Pick ONE:
- **Utility Bar item (best for "always one click"):** App Manager → your app → Edit → Utility Items → Add **Flow** → choose *Daily Briefing*. Now it's a permanent button at the bottom of the screen.
- **Home Page component:** Edit the Home page in App Builder → drag the **Flow** component → select *Daily Briefing*. The briefing renders the moment they land on Home — **zero clicks**.
- **App/Tab:** create a Flow tab if you want it in the nav bar.

### Step 5 — Verify
Run it as a rep with real data. Check sorting, dates (MM-DD-YYYY), and that record/Flow/Slack buttons link correctly. Regression-test with `daily-briefing-prompt-harness.md`.

### Wiring Alerts & Slack (optional, later)
The Apex returns `[]` for both until you connect a source. Fill in:
- `getAlerts()` — query your notification/alert object (or CustomNotification log, or a custom object).
- `getSlackMessages()` — call Slack via a **Named Credential** + the Slack API, or read a synced Slack-message object if you use Slack-Salesforce integration. Prioritize direct mentions.

Each returned item must match the schema in `daily-briefing-prompt-harness.md` (field-mapping notes).

---

# OPTION 2 — LWC + Apex (most control, best button styling)

Use this when you want the **button-styled links to render reliably** (Flow's rich-text
sanitizer can strip inline styles; an LWC renders the HTML yourself, so styling is exact),
or you want auto-refresh, loading spinners, and a polished card UI.

### How it differs from Option 1
- **Reuse the same `DailyBriefingController`** — but expose a method with `@AuraEnabled(cacheable=true)` that returns the HTML string (you can keep the invocable too).
- Build a small LWC that calls it with `@wire` and injects the HTML.

### Sketch
**Apex (add to the controller):**
```apex
@AuraEnabled(cacheable=true)
public static String getBriefingHtml() {
    return callPromptTemplate(buildPayloadJson(UserInfo.getUserId()));
}
```

**LWC `dailyBriefing.js`:**
```js
import { LightningElement, wire } from 'lwc';
import getBriefingHtml from '@salesforce/apex/DailyBriefingController.getBriefingHtml';

export default class DailyBriefing extends LightningElement {
    html;
    error;
    @wire(getBriefingHtml)
    wired({ data, error }) {
        if (data) this.html = data;
        if (error) this.error = error;
    }
    renderedCallback() {
        const c = this.template.querySelector('.briefing');
        if (c && this.html) c.innerHTML = this.html; // you control sanitization here
    }
}
```

**LWC `dailyBriefing.html`:**
```html
<template>
    <lightning-card title="My Day" icon-name="utility:sales_path">
        <div class="briefing slds-p-around_medium"></div>
        <template if:true={error}>
            <p class="slds-text-color_error slds-p-around_medium">Couldn't load your briefing.</p>
        </template>
    </lightning-card>
</template>
```

**`dailyBriefing.js-meta.xml`** → expose to `lightning__HomePage`, `lightning__AppPage`, `lightning__RecordPage`.

### Deploy & place
- Deploy the LWC bundle + Apex.
- Drop the component on the **Home page** in App Builder. Zero clicks for the rep.

### Tune each list per placement (no redeploy)
Select the component in App Builder to configure it — the same component can be focused on a
Home page and full on an App page:
- **Filters** (applied at the data source, before the rep's in‑page search/sort):
  *Accounts by health* (All / At Risk / Critical / Churned), *Tasks by priority* and
  *Cases by priority* (All / High only), *Applications* (All / Needs decision only), and a
  *Min opportunity amount* threshold.
- **Row limits:** a global *Max records per section*, plus a per‑section *Max rows* for
  Accounts / Tasks / Cases / Opportunities / Applications / Alerts / Slack (`0` = inherit the global).
- **Show/hide** each section, set **accent colors**, and pick the default **account scope**.

The shipped **Daily Briefing Home** page comes preconfigured for a focused start‑of‑day view
(Max records 5; Accounts = Critical; Tasks/Cases = High only; Applications = Needs decision only).
See the design‑properties table in the repo `README.md` for the full list.

> Trade-off: more reliable styling and UX, but you own the HTML injection (use a trusted
> source — this HTML comes from your own prompt, not user input, which keeps it safe).

---

# OPTION 3 — Agentforce / Einstein Copilot (conversational)

Use this when reps would rather **ask** ("what's on my plate today?") than open a page.

### How it differs
- The same **Prompt Template** (`Daily_Briefing_Prompt`) is reused as the grounding.
- You wrap the data-gathering in an **Agent Action** (an invocable Apex or a Flow) and
  register it as a topic the agent can call.

### Steps
1. Keep the Prompt Template from Option 1.
2. Make the data-gatherer callable by the agent:
   - Easiest: reuse `DailyBriefingController.getBriefing` (it's already `@InvocableMethod`),
     OR create a thin autolaunched Flow that calls it.
3. Setup → **Agentforce / Agent Builder** → open your agent.
4. **New Topic** e.g. *"Daily Briefing"* with instructions like *"When the user asks what to
   work on, what's on their plate, or for a summary of their day, call the Get Daily Briefing
   action and present the result."*
5. Add the **Action** that points to the invocable/Flow.
6. Test in the Agent preview: *"What should I focus on today?"*

### Notes
- Output rendering: in chat, the agent will summarize/relay the content. If you need the rich
  HTML table layout, an embedded page (Option 1/2) is better; Agentforce is best for a
  spoken/short conversational summary plus links.
- This is additive — you can run Option 1 (the page) **and** Option 3 (the agent) off the
  same prompt and Apex.

---

# Decision cheat-sheet
| You want… | Use |
|---|---|
| Fewest clicks to ship, low-code, good enough styling | **Option 1 — Screen Flow** |
| Pixel-perfect buttons, spinners, auto-refresh, card UI | **Option 2 — LWC + Apex** |
| Reps to *ask* for their day in natural language | **Option 3 — Agentforce** |

All three share the **same Prompt Template** and the **same `DailyBriefingController`**,
so you can start with Option 1 and add the others later with no rework.

---

## Appendix A — Flow-calls-the-prompt fallback (if Apex ConnectApi isn't available)
If your org/API version can't call the prompt from Apex, keep Apex for *data assembly only*
and let the Flow call the prompt. The Flow becomes 3 elements:
1. **Apex action** → a variant of the controller that returns the **JSON string** (not HTML).
   Add: `@InvocableVariable public String payloadJson;` and return it instead of `htmlOutput`.
2. **Prompt Template action** (native Flow element) → choose `Daily_Briefing_Prompt`,
   pass the JSON into its `userInstructions` input.
3. **Screen** → Display Text bound to the prompt action's response text.

Still only one extra click in Flow Builder, and no ConnectApi dependency.

## Appendix B — Button rendering reality check
- **Flow Display Text** keeps `<a href>` reliably; inline `style` *may* be stripped depending
  on runtime → buttons degrade to plain links (still functional). Test in your org.
- **LWC (Option 2)** renders styled buttons exactly as written.
- Real *interactive* actions (mark complete, snooze) must live in the Flow/LWC layer — the
  prompt only emits navigational links.
