/**
 * DailyBriefingController
 * ------------------------
 * Single Apex action that does EVERYTHING for the "Start Your Day" briefing:
 *   1. Gathers the running user's Tasks, Accounts, Opportunities, Cases (+ pluggable Alerts/Slack)
 *   2. Builds the JSON the Prompt Template expects
 *   3. Calls the Prompt Template and returns the formatted HTML
 *
 * The Screen Flow then only needs TWO elements: this action + one display screen.
 *
 * NOTE: the ConnectApi prompt-template call (callPromptTemplate) uses APIs that have
 * evolved across releases. Verify the class/method names against your org's API version
 * (Setup > Apex Classes > New, type "ConnectApi.EinsteinLLM" to confirm autocomplete).
 */
public with sharing class DailyBriefingController {

    // ---- Flow entry/exit wrappers ----
    public class Request {
        @InvocableVariable(label='User Id (optional — defaults to running user)')
        public Id userId;
        @InvocableVariable(label='Account Scope: "owner" (default) or "engagement"')
        public String accountScope;
    }
    public class Response {
        @InvocableVariable(label='Briefing HTML')
        public String htmlOutput;
    }

    @InvocableMethod(label='Get Daily Briefing'
                     description='Assembles the rep\'s day and returns formatted HTML for a Flow screen')
    public static List<Response> getBriefing(List<Request> requests) {
        Request req = (requests != null && !requests.isEmpty() && requests[0] != null)
            ? requests[0] : new Request();
        Id uid = (req.userId != null) ? req.userId : UserInfo.getUserId();

        String html;
        try {
            String payload = buildPayloadJson(uid, normalizeScope(req.accountScope));
            html = callPromptTemplate(payload);
        } catch (Exception e) {
            html = errorHtml(e);
        }

        Response res = new Response();
        res.htmlOutput = html;
        return new List<Response>{ res };
    }

    // =====================================================================
    // LWC entry point (Option 2). Imperative, not cacheable: each open runs
    // a fresh generation, and the ConnectApi call shouldn't be cached.
    // accountScope: 'owner' (accounts the user owns) or 'engagement'
    // (owns OR has open opps/cases on).
    // =====================================================================
    @AuraEnabled
    public static String getBriefingHtml(String accountScope) {
        try {
            return callPromptTemplate(buildPayloadJson(UserInfo.getUserId(), normalizeScope(accountScope)));
        } catch (Exception e) {
            return errorHtml(e);
        }
    }

    // Structured data for the native LWC dashboard (renders its own SLDS UI).
    @AuraEnabled
    public static String getBriefingData(String accountScope) {
        return buildPayloadJson(UserInfo.getUserId(), normalizeScope(accountScope));
    }

    // AI: a short executive summary of the user's day.
    @AuraEnabled
    public static String getAISummary(String accountScope) {
        return runPrompt(
            'Give me a 2-3 sentence executive summary of my day, then name the single '
            + 'most important thing to do first. Reference the highest-value or most urgent '
            + 'items by name. Plain text, no markdown.',
            accountScope
        );
    }

    // AI: run a free-form prompt grounded ONLY on the running user's briefing data.
    @AuraEnabled
    public static String runPrompt(String userPrompt, String accountScope) {
        try {
            String data = buildPayloadJson(UserInfo.getUserId(), normalizeScope(accountScope));
            String prompt =
                'You are a concise sales and service assistant. Use ONLY the JSON below, '
                + 'which describes the current user\'s open work for today, to answer the question. '
                + 'If the answer is not in the data, say so briefly. Answer in plain text, no markdown.\n\n'
                + 'DATA:\n' + data + '\n\nQUESTION: '
                + (String.isBlank(userPrompt) ? 'Summarize my day.' : userPrompt);
            return callLlm(prompt);
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    // Create a Slack swarm channel for a case and post the opening message.
    // Uses the "Slack" Named Credential when ENABLE_SLACK is true; otherwise returns
    // a simulated result so the UI works before Slack auth is configured.
    @AuraEnabled
    public static Map<String, Object> initiateSlackSwarm(Id caseId) {
        Case c = [SELECT Id, CaseNumber, Subject FROM Case WHERE Id = :caseId LIMIT 1];
        String channelName = ('swarm-' + c.CaseNumber).toLowerCase();
        String redirect = 'https://slack.com/app_redirect?channel='
            + EncodingUtil.urlEncode(channelName, 'UTF-8');
        Map<String, Object> result = new Map<String, Object>{
            'caseNumber' => c.CaseNumber,
            'subject' => c.Subject,
            'channel' => '#' + channelName,
            'threadUrl' => redirect
        };

        if (!ENABLE_SLACK) {
            result.put('simulated', true);
            return result;
        }

        try {
            // 1. Create the channel (conversations.create — needs channels:manage scope)
            HttpRequest createReq = new HttpRequest();
            createReq.setEndpoint('callout:Slack/api/conversations.create');
            createReq.setMethod('POST');
            createReq.setHeader('Content-Type', 'application/json; charset=utf-8');
            createReq.setBody(JSON.serialize(new Map<String, Object>{ 'name' => channelName }));
            HttpResponse createRes = new Http().send(createReq);
            Map<String, Object> cbody =
                (Map<String, Object>) JSON.deserializeUntyped(createRes.getBody());

            String channelId = channelName;
            if (cbody.get('ok') == true) {
                channelId = (String) ((Map<String, Object>) cbody.get('channel')).get('id');
            } else if (String.valueOf(cbody.get('error')) != 'name_taken') {
                throw new CalloutException('Slack conversations.create: ' + cbody.get('error'));
            }

            // 2. Post the opening message (chat.postMessage — needs chat:write scope)
            HttpRequest postReq = new HttpRequest();
            postReq.setEndpoint('callout:Slack/api/chat.postMessage');
            postReq.setMethod('POST');
            postReq.setHeader('Content-Type', 'application/json; charset=utf-8');
            postReq.setBody(JSON.serialize(new Map<String, Object>{
                'channel' => channelId,
                'text' => 'Swarm started for case ' + c.CaseNumber + ' — ' + c.Subject
            }));
            new Http().send(postReq);

            result.put('simulated', false);
            return result;
        } catch (Exception e) {
            throw new AuraHandledException('Slack swarm failed: ' + e.getMessage());
        }
    }

    private static String callLlm(String prompt) {
        ConnectApi.EinsteinLlmGenerationsInput input = new ConnectApi.EinsteinLlmGenerationsInput();
        input.promptTextorId = prompt;
        input.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
        input.additionalConfig.numGenerations = 1;
        input.additionalConfig.enablePiiMasking = false;
        input.additionalConfig.applicationName = 'PromptBuilderPreview';
        ConnectApi.EinsteinLLMGenerationsOutput resp = ConnectApi.EinsteinLLM.generateMessages(input);
        return (resp != null && resp.generations != null && !resp.generations.isEmpty())
            ? resp.generations[0].text
            : '';
    }

    private static String normalizeScope(String scope) {
        return (scope != null && scope.toLowerCase() == 'engagement') ? 'engagement' : 'owner';
    }

    private static String errorHtml(Exception e) {
        return '<p class="slds-text-color_error">Unable to generate your briefing right now: '
             + String.escapeSingleQuotes(e.getMessage()) + '</p>';
    }

    // =====================================================================
    // 1. Gather data + build the JSON the prompt expects
    // =====================================================================
    @TestVisible
    private static String buildPayloadJson(Id uid, String scope) {
        Date today = Date.today();
        Map<String, Object> payload = new Map<String, Object>();
        payload.put('asOfDate', String.valueOf(today)); // YYYY-MM-DD

        User u = [SELECT Name FROM User WHERE Id = :uid LIMIT 1];
        payload.put('user', new Map<String, Object>{ 'Name' => u.Name, 'Role' => 'Sales' });

        // --- Accounts needing attention: at-risk / critical / churned, or churn-flagged ---
        // Scope controls WHICH accounts: 'owner' = owned only;
        // 'engagement' = owned OR has an open opp/case the user is working.
        String healthFilter =
            '(SDO_AI_AccountHealth__c IN (\'At Risk\', \'Critical\', \'Churned\') '
            + 'OR SDO_CPQ_Churn_Risk__c = true)';

        // For engagement scope, gather accounts the user has open opps/cases on.
        // (Semi-joins can't sit inside an OR, so we pre-resolve the IDs and bind them.)
        Set<Id> engagedAcctIds = new Set<Id>();
        if (scope == 'engagement') {
            for (Opportunity eo : [
                SELECT AccountId FROM Opportunity
                WHERE OwnerId = :uid AND IsClosed = false AND AccountId != null
            ]) { engagedAcctIds.add(eo.AccountId); }
            for (Case ec : [
                SELECT AccountId FROM Case
                WHERE OwnerId = :uid AND IsClosed = false AND AccountId != null
            ]) { engagedAcctIds.add(ec.AccountId); }
        }

        String scopeFilter = (scope == 'engagement')
            ? '(OwnerId = :uid OR Id IN :engagedAcctIds)'
            : 'OwnerId = :uid';
        String acctQuery =
            'SELECT Id, Name, Owner.Name, AnnualRevenue, SDO_AI_AccountHealth__c, SDO_CPQ_Churn_Risk__c '
            + 'FROM Account WHERE ' + scopeFilter + ' AND ' + healthFilter
            + ' ORDER BY AnnualRevenue DESC NULLS LAST LIMIT 50';

        List<Object> accounts = new List<Object>();
        for (Account a : Database.query(acctQuery)) {
            String riskReason = (a.SDO_CPQ_Churn_Risk__c == true)
                ? 'Flagged as a churn risk'
                : 'Account health is ' + a.SDO_AI_AccountHealth__c;
            accounts.add(new Map<String, Object>{
                'Id' => a.Id,
                'Name' => a.Name,
                'Owner' => a.Owner.Name,
                'HealthStatus' => a.SDO_AI_AccountHealth__c,
                'RiskReason'   => riskReason,
                'AnnualRevenue'=> a.AnnualRevenue,
                'RenewalDate'  => null   // no clean renewal-date field on Account in this org
            });
        }
        payload.put('accounts', accounts);

        // --- Open Tasks ---
        List<Object> tasks = new List<Object>();
        for (Task t : [
            SELECT Id, Subject, What.Name, WhatId, ActivityDate, Priority, Status
            FROM Task
            WHERE OwnerId = :uid AND IsClosed = false
            ORDER BY ActivityDate ASC NULLS LAST
            LIMIT 50
        ]) {
            tasks.add(new Map<String, Object>{
                'Id' => t.Id,
                'Subject' => t.Subject,
                'RelatedTo' => (t.What != null ? t.What.Name : null),
                'RelatedToId' => t.WhatId,
                'ActivityDate' => (t.ActivityDate != null ? String.valueOf(t.ActivityDate) : null),
                'Priority' => t.Priority,
                'Status' => t.Status,
                'IsCustomerFacing' => (t.WhatId != null)
            });
        }
        payload.put('tasks', tasks);

        // --- Open Opportunities (prompt flags overdue itself) ---
        List<Object> opps = new List<Object>();
        for (Opportunity o : [
            SELECT Id, Name, Account.Name, AccountId, Amount, StageName, CloseDate, IsClosed
            FROM Opportunity
            WHERE OwnerId = :uid AND IsClosed = false
            ORDER BY Amount DESC NULLS LAST
            LIMIT 50
        ]) {
            opps.add(new Map<String, Object>{
                'Id' => o.Id,
                'Name' => o.Name,
                'AccountName' => (o.Account != null ? o.Account.Name : null),
                'AccountId' => o.AccountId,
                'Amount' => o.Amount,
                'StageName' => o.StageName,
                'CloseDate' => String.valueOf(o.CloseDate),
                'IsClosed' => o.IsClosed
            });
        }
        payload.put('opportunities', opps);

        // --- Open Cases ---
        List<Object> cases = new List<Object>();
        for (Case c : [
            SELECT Id, CaseNumber, Subject, Account.Name, AccountId, Priority, Status, CreatedDate
            FROM Case
            WHERE OwnerId = :uid AND IsClosed = false
            ORDER BY CreatedDate ASC
            LIMIT 50
        ]) {
            cases.add(new Map<String, Object>{
                'Id' => c.Id,
                'CaseNumber' => c.CaseNumber,
                'Subject' => c.Subject,
                'AccountName' => (c.Account != null ? c.Account.Name : null),
                'AccountId' => c.AccountId,
                'Priority' => c.Priority,
                'Status' => c.Status,
                'CreatedDate' => String.valueOf(c.CreatedDate.date())
            });
        }
        payload.put('cases', cases);

        // --- Applications (Application__c): ALL pending applications the user can see ---
        // Pending = not yet Approved (auto/manual) or Declined. "with sharing" limits
        // this to records the running user has access to.
        // Organized by status, then close date, then amount (largest first).
        List<Object> applications = new List<Object>();
        for (Application__c ap : [
            SELECT Id, Name, Application_Number__c, Amount__c, Decision_Status__c,
                   Close_Date__c, CreatedDate
            FROM Application__c
            WHERE Decision_Status__c = null
               OR Decision_Status__c NOT IN ('Manually Approved', 'Auto Approved', 'Declined')
            ORDER BY Decision_Status__c ASC, Close_Date__c ASC NULLS LAST, Amount__c DESC
            LIMIT 200
        ]) {
            applications.add(new Map<String, Object>{
                'Id' => ap.Id,
                'Name' => ap.Name,
                'ApplicationNumber' => ap.Application_Number__c,
                'Amount' => ap.Amount__c,
                'Status' => ap.Decision_Status__c,
                'CloseDate' => (ap.Close_Date__c != null ? String.valueOf(ap.Close_Date__c) : null),
                'Created' => String.valueOf(ap.CreatedDate.date())
            });
        }
        payload.put('applications', applications);

        // --- Alerts + Slack (pluggable; empty until you wire them) ---
        payload.put('alerts', getAlerts(uid));
        payload.put('slackMessages', getSlackMessages(uid));

        return JSON.serialize(payload, true); // suppress apex nulls
    }

    // =====================================================================
    // Alerts — wired to pending approval requests assigned to the user.
    // ProcessInstanceWorkitem = an approval step awaiting this user's action.
    // =====================================================================
    @TestVisible
    private static List<Object> getAlerts(Id uid) {
        List<Object> alerts = new List<Object>();
        for (ProcessInstanceWorkitem w : [
            SELECT Id, CreatedDate, ProcessInstance.TargetObjectId, ProcessInstance.Status
            FROM ProcessInstanceWorkitem
            WHERE ActorId = :uid
            ORDER BY CreatedDate DESC
            LIMIT 25
        ]) {
            Id targetId = (w.ProcessInstance != null) ? w.ProcessInstance.TargetObjectId : null;
            String objName = (targetId != null)
                ? targetId.getSObjectType().getDescribe().getName() : null;
            alerts.add(new Map<String, Object>{
                'Id' => w.Id,
                'Subject' => 'Approval pending your review',
                'RelatedId' => targetId,
                'RelatedObject' => objName,
                'Type' => 'Approval',
                'Date' => String.valueOf(w.CreatedDate.date()),
                'FlowApiName' => null   // native approval — action button links to the record
            });
        }
        return alerts;
    }

    // =====================================================================
    // Slack — wired to Slack Web API search.messages (messages mentioning the
    // running user) via a Named Credential. Salesforce stores no Slack message
    // data natively, so this is a live callout.
    //
    // TO ENABLE:
    //   1. Create a Slack app (user token scope: search:read).
    //   2. Setup > Named Credentials > New, name = "Slack",
    //      URL = https://slack.com/  (OAuth 2.0 / per-user or named principal with the token).
    //   3. Flip ENABLE_SLACK to true and redeploy.
    // Until enabled (or if the callout fails), returns [] and the Slack section
    // simply doesn't render — no errors.
    // =====================================================================
    @TestVisible private static Boolean ENABLE_SLACK = false; // set true after Named Credential "Slack" exists

    @TestVisible
    private static List<Object> getSlackMessages(Id uid) {
        List<Object> msgs = new List<Object>();
        if (!ENABLE_SLACK || Test.isRunningTest()) {
            return msgs; // off, or skip live callout in tests
        }
        try {
            HttpRequest req = new HttpRequest();
            String q = EncodingUtil.urlEncode('has:@me', 'UTF-8'); // messages mentioning the authed user
            req.setEndpoint('callout:Slack/api/search.messages?count=10&sort=timestamp&query=' + q);
            req.setMethod('GET');
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() != 200) { return msgs; }

            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            if (body.get('ok') != true) { return msgs; }
            Map<String, Object> messages = (Map<String, Object>) body.get('messages');
            if (messages == null) { return msgs; }
            List<Object> matches = (List<Object>) messages.get('matches');
            if (matches == null) { return msgs; }

            for (Object o : matches) {
                Map<String, Object> m = (Map<String, Object>) o;
                Map<String, Object> ch = (Map<String, Object>) m.get('channel');
                String received;
                Object tsObj = m.get('ts');
                if (tsObj != null) {
                    Long ms = (Long) (Decimal.valueOf(String.valueOf(tsObj)) * 1000);
                    received = String.valueOf(DateTime.newInstance(ms).date());
                }
                msgs.add(new Map<String, Object>{
                    'Id' => (String) m.get('iid'),
                    'From' => (String) m.get('username'),
                    'Channel' => (ch != null ? '#' + (String) ch.get('name') : null),
                    'Preview' => (String) m.get('text'),
                    'ReceivedDate' => received,
                    'ThreadUrl' => (String) m.get('permalink'),
                    'IsDirectMention' => true
                });
            }
        } catch (Exception e) {
            return new List<Object>(); // no Named Credential yet / callout error → degrade quietly
        }
        return msgs;
    }

    // =====================================================================
    // 2. Call the Prompt Template -> return HTML
    // =====================================================================
    @TestVisible
    private static String callPromptTemplate(String payloadJson) {
        ConnectApi.EinsteinPromptTemplateGenerationsInput input =
            new ConnectApi.EinsteinPromptTemplateGenerationsInput();

        ConnectApi.WrappedValue wv = new ConnectApi.WrappedValue();
        wv.value = payloadJson;

        Map<String, ConnectApi.WrappedValue> params = new Map<String, ConnectApi.WrappedValue>();
        // Key must match the prompt's input variable: {!$Input:userInstructions}
        params.put('Input:userInstructions', wv);
        input.inputParams = params;

        input.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
        input.additionalConfig.numGenerations = 1;
        input.additionalConfig.enablePiiMasking = false;
        // applicationName intentionally left unset — this org rejects a hardcoded
        // value ("must be an existing registered ai application"); unset works.
        input.isPreview = false;

        ConnectApi.EinsteinPromptTemplateGenerationsRepresentation resp =
            ConnectApi.EinsteinLLM.generateMessagesForPromptTemplate(
                'Daily_Briefing_Prompt', input); // <-- your Prompt Template API name

        if (resp != null && resp.generations != null && !resp.generations.isEmpty()) {
            return resp.generations[0].text;
        }
        return '<p class="slds-text-color_weak">No briefing content was returned.</p>';
    }
}
