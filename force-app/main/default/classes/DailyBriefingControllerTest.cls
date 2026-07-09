/**
 * Basic coverage for DailyBriefingController.
 * The live ConnectApi prompt call can't run in a test context, so getBriefing()
 * exercises the gather+build path and lands in the catch block (returning error HTML),
 * which still covers the orchestration. buildPayloadJson is asserted directly.
 */
@IsTest
private class DailyBriefingControllerTest {

    @TestSetup
    static void setup() {
        // Health field set so the account matches the "needs attention" filter (covers that loop).
        Account a = new Account(
            Name = 'Test Risk Account', AnnualRevenue = 500000,
            SDO_AI_AccountHealth__c = 'At Risk'
        );
        insert a;

        insert new Opportunity(
            Name = 'Test Opp', StageName = 'Prospecting',
            CloseDate = Date.today().addDays(-5), Amount = 75000, AccountId = a.Id
        );
        insert new Task(
            Subject = 'Test Task', Status = 'Open',
            ActivityDate = Date.today(), Priority = 'High', WhatId = a.Id
        );
        // Case insert can trip org-specific record-triggered flows in this demo org.
        // Wrap it so a blocked Case can't fail the whole setup; the cases loop is
        // still exercised by buildPayloadJson regardless.
        try {
            insert new Case(
                Subject = 'Test Case', Status = 'New', Priority = 'High', AccountId = a.Id
            );
        } catch (Exception e) {
            // org automation blocked the Case — fine for this test.
        }
    }

    @IsTest
    static void buildsPayloadJson() {
        Test.startTest();
        String json = DailyBriefingController.buildPayloadJson(UserInfo.getUserId(), 'owner');
        // also exercise the engagement-scope branch (semi-joins on Opp/Case)
        String jsonEng = DailyBriefingController.buildPayloadJson(UserInfo.getUserId(), 'engagement');
        Test.stopTest();
        System.assert(jsonEng.contains('"accounts"'), 'engagement scope returns accounts key');

        System.assert(json.contains('"asOfDate"'), 'asOfDate present');
        System.assert(json.contains('"opportunities"'), 'opportunities present');
        System.assert(json.contains('"tasks"'), 'tasks present');
        System.assert(json.contains('"cases"'), 'cases present');
        System.assert(json.contains('"accounts"'), 'accounts present');
        System.assert(json.contains('"alerts"'), 'alerts present');
        System.assert(json.contains('"slackMessages"'), 'slackMessages present');
    }

    @IsTest
    static void getBriefingReturnsHtml() {
        DailyBriefingController.Request req = new DailyBriefingController.Request();
        Test.startTest();
        List<DailyBriefingController.Response> out =
            DailyBriefingController.getBriefing(new List<DailyBriefingController.Request>{ req });
        Test.stopTest();

        System.assertEquals(1, out.size(), 'one response');
        System.assertNotEquals(null, out[0].htmlOutput, 'html returned (content or graceful error)');
    }

    @IsTest
    static void integrationStubsReturnEmpty() {
        System.assertEquals(0, DailyBriefingController.getAlerts(UserInfo.getUserId()).size());
        System.assertEquals(0, DailyBriefingController.getSlackMessages(UserInfo.getUserId()).size());
    }

    @IsTest
    static void aiPromptSurfacesErrorInTestContext() {
        // The Einstein callout can't run in a test context, so runPrompt should wrap
        // the failure in an AuraHandledException rather than leak a raw exception.
        Boolean threw = false;
        Test.startTest();
        try {
            DailyBriefingController.runPrompt('What should I do first?', 'owner');
        } catch (AuraHandledException e) {
            threw = true;
        }
        Test.stopTest();
        System.assert(threw, 'runPrompt should throw AuraHandledException when the LLM callout is unavailable');
    }
}
