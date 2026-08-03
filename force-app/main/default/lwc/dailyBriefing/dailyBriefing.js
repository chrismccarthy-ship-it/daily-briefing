import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { deleteRecord, updateRecord } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LightningConfirm from 'lightning/confirm';
import AssignOwnerModal from 'c/assignOwnerModal';
import FlowLauncherModal from 'c/flowLauncherModal';
import getBriefingData from '@salesforce/apex/DailyBriefingController.getBriefingData';
import getAISummary from '@salesforce/apex/DailyBriefingController.getAISummary';
import runPrompt from '@salesforce/apex/DailyBriefingController.runPrompt';
import initiateSlackSwarm from '@salesforce/apex/DailyBriefingController.initiateSlackSwarm';

const TEAMS_FLOW = 'Escalation_to_Teams';

const CURRENCY = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
});

function fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return m && d ? `${m}-${d}-${y}` : iso;
}

// business-mode section visibility
const SALES_ONLY = new Set(['accounts', 'opportunities']); // hidden in Service mode
const SERVICE_ONLY = new Set(['cases']); // hidden in Sales mode

// typed per-section filters (bound to a column index). type: picklist | date | search
const STRUCTURED = {
    tasks: [
        { id: 'priority', label: 'Priority', type: 'picklist', col: 3 },
        { id: 'status', label: 'Status', type: 'picklist', col: 4 },
        { id: 'due', label: 'Due on/before', type: 'date', col: 2 }
    ],
    cases: [
        { id: 'priority', label: 'Priority', type: 'picklist', col: 2 },
        { id: 'status', label: 'Status', type: 'picklist', col: 3 }
    ],
    opportunities: [
        { id: 'stage', label: 'Stage', type: 'picklist', col: 3 },
        { id: 'close', label: 'Close on/before', type: 'date', col: 4 },
        { id: 'account', label: 'Account', type: 'search', col: 1 }
    ]
};

export default class DailyBriefing extends NavigationMixin(LightningElement) {
    // --- App Builder design properties ---
    @api defaultScope = 'owner';
    @api hideScopeToggle = false;
    @api hideAccounts = false;
    @api hideTasks = false;
    @api hideCases = false;
    @api hideOpportunities = false;
    @api hideAlerts = false;
    @api hideSlack = false;
    @api accentAccounts = '#B7791F';
    @api accentTasks = '#1B69C4';
    @api accentCases = '#C23934';
    @api accentOpportunities = '#2E844A';
    @api accentAlerts = '#5A3FD6';
    @api accentSlack = '#611F69';
    @api accentApplications = '#0B7285';
    @api maxRecords = 10;
    @api hideAiSummary = false;
    @api hideApplications = false;

    // Per-section row caps (0 = inherit the global "Max records per section").
    @api maxAccounts = 0;
    @api maxTasks = 0;
    @api maxCases = 0;
    @api maxOpportunities = 0;
    @api maxApplications = 0;
    @api maxAlerts = 0;
    @api maxSlack = 0;

    // Per-section admin filters (App Builder). Applied before the in-page filters.
    @api accountsHealthFilter = 'All'; // All | At Risk | Critical | Churned
    @api tasksPriorityFilter = 'All'; // All | High only
    @api casesPriorityFilter = 'All'; // All | High only
    @api opportunitiesMinAmount = 0; // only overdue opps with Amount >= value (0 = all)
    @api applicationsFilter = 'All'; // All | Needs decision only

    scope = 'owner';
    isLoading = true;
    errorMessage;
    data;

    // interaction state
    searchTerm = '';
    businessMode = 'all';
    collapsed = {};
    sortState = {};
    sectionSearch = {};
    columnFilters = {};
    filtersOpen = {};
    structured = {};

    // AI panel state
    aiSummary;
    aiSummaryLoading = false;
    aiError;
    aiPrompt = '';
    aiAnswer;
    aiAnswerLoading = false;

    // Slack swarms created this session (shown in the Slack section)
    localSwarms = [];

    get showAi() {
        return !this.hideAiSummary;
    }
    get runDisabled() {
        return this.aiAnswerLoading || !this.aiPrompt.trim();
    }
    get promptGroups() {
        return [
            {
                key: 'service',
                label: 'Service',
                chips: [
                    { key: 's1', label: 'Triage my cases', prompt: 'Summarize my open cases and tell me which to handle first and why.' },
                    { key: 's2', label: 'Draft case update', prompt: 'Draft a short customer update for my highest-priority case.' },
                    { key: 's3', label: 'At-risk accounts', prompt: 'Which of my accounts are at risk and what should I do about each?' }
                ]
            },
            {
                key: 'sales',
                label: 'Sales',
                chips: [
                    { key: 'a1', label: 'Prioritize deals', prompt: 'Prioritize my overdue opportunities by amount and give the next step for each.' },
                    { key: 'a2', label: 'Outreach for top deal', prompt: 'Draft outreach to re-engage the customer on my largest overdue opportunity.' },
                    { key: 'a3', label: 'Closing soonest', prompt: 'Which of my opportunities are closing soonest and what is at risk?' }
                ]
            },
            {
                key: 'deleg',
                label: 'Task delegation',
                chips: [
                    { key: 'd1', label: 'What to delegate', prompt: 'Which of my open tasks should I delegate, and who or which team should each go to?' },
                    { key: 'd2', label: 'Due today', prompt: 'Summarize my tasks due today and flag anything overdue.' },
                    { key: 'd3', label: 'Delegation note', prompt: 'Draft a short delegation message handing off my lowest-priority tasks.' }
                ]
            }
        ];
    }
    handleChip(event) {
        this.aiPrompt = event.currentTarget.dataset.prompt || '';
        this.runUserPrompt();
    }

    connectedCallback() {
        this.scope = this.defaultScope === 'engagement' ? 'engagement' : 'owner';
        this.load();
    }

    async load() {
        this.isLoading = true;
        this.errorMessage = undefined;
        try {
            const raw = await getBriefingData({ accountScope: this.scope });
            this.data = JSON.parse(raw);
        } catch (e) {
            this.errorMessage = this._msg(e) || 'Could not load your briefing.';
            this.data = undefined;
        } finally {
            this.isLoading = false;
        }
        if (this.showAi) this.loadSummary();
    }

    async loadSummary() {
        this.aiSummaryLoading = true;
        this.aiError = undefined;
        try {
            this.aiSummary = await getAISummary({ accountScope: this.scope });
        } catch (e) {
            this.aiError = this._msg(e);
            this.aiSummary = undefined;
        } finally {
            this.aiSummaryLoading = false;
        }
    }

    handleAiPromptChange(event) {
        this.aiPrompt = event.target.value || '';
    }
    handleAiKey(event) {
        if (event.key === 'Enter') this.runUserPrompt();
    }
    async runUserPrompt() {
        const q = this.aiPrompt.trim();
        if (!q) return;
        this.aiAnswerLoading = true;
        this.aiAnswer = undefined;
        try {
            this.aiAnswer = await runPrompt({ userPrompt: q, accountScope: this.scope });
        } catch (e) {
            this.aiAnswer = undefined;
            this._toast('Prompt failed', this._msg(e), 'error');
        } finally {
            this.aiAnswerLoading = false;
        }
    }

    // ---- header ----
    get userName() {
        return this.data && this.data.user ? this.data.user.Name : '';
    }
    get asOf() {
        return this.data ? fmtDate(this.data.asOfDate) : '';
    }
    get isEngagement() {
        return this.scope === 'engagement';
    }
    get showToggle() {
        return !this.hideScopeToggle;
    }
    get modeOptions() {
        return [
            { label: 'All', value: 'all' },
            { label: 'Sales', value: 'sales' },
            { label: 'Service', value: 'service' }
        ];
    }
    get limit() {
        const n = parseInt(this.maxRecords, 10);
        return !n || n < 1 ? 9999 : n;
    }

    // Per-section row cap: use the section override when set (>0), else the global limit.
    _sectionLimit(key) {
        const per = {
            accounts: this.maxAccounts,
            tasks: this.maxTasks,
            cases: this.maxCases,
            opportunities: this.maxOpportunities,
            applications: this.maxApplications,
            alerts: this.maxAlerts,
            slack: this.maxSlack
        };
        const n = parseInt(per[key], 10);
        return n && n > 0 ? n : this.limit;
    }

    // ---- admin (App Builder) source filters: applied before rows are built ----
    _filteredAccounts() {
        const list = (this.data && this.data.accounts) || [];
        const f = this.accountsHealthFilter;
        if (!f || f === 'All') return list;
        return list.filter((a) => (a.HealthStatus || '') === f);
    }
    _filteredTasks() {
        const list = (this.data && this.data.tasks) || [];
        return this.tasksPriorityFilter === 'High only'
            ? list.filter((t) => this._isHigh(t.Priority))
            : list;
    }
    _filteredCases() {
        const list = (this.data && this.data.cases) || [];
        return this.casesPriorityFilter === 'High only'
            ? list.filter((c) => this._isHigh(c.Priority) || this._isEscalated(c.Status))
            : list;
    }
    _filteredApplications() {
        const list = (this.data && this.data.applications) || [];
        return this.applicationsFilter === 'Needs decision only'
            ? list.filter((a) => this._appNeedsDecision(a))
            : list;
    }

    // section visibility = admin hide toggles + business-mode filter
    _isSectionVisible(key) {
        const hide = {
            accounts: this.hideAccounts,
            tasks: this.hideTasks,
            cases: this.hideCases,
            opportunities: this.hideOpportunities,
            applications: this.hideApplications,
            alerts: this.hideAlerts,
            slack: this.hideSlack
        };
        if (hide[key]) return false;
        if (this.businessMode === 'service' && SALES_ONLY.has(key)) return false;
        if (this.businessMode === 'sales' && SERVICE_ONLY.has(key)) return false;
        return true;
    }

    // ---- counts (totals, but only for visible sections) ----
    get counts() {
        const d = this.data || {};
        return [
            { key: 'a', section: 'accounts', label: 'At-risk accounts', value: this._filteredAccounts().length },
            { key: 't', section: 'tasks', label: 'Open tasks', value: this._filteredTasks().length },
            { key: 'c', section: 'cases', label: 'High-priority cases', value: this._highCaseCount() },
            { key: 'o', section: 'opportunities', label: 'Overdue opps', value: this._overdueOpps().length },
            { key: 'p', section: 'applications', label: 'Apps to review', value: this._appsToReview().length },
            { key: 'l', section: 'alerts', label: 'Alerts', value: (d.alerts || []).length },
            { key: 's', section: 'slack', label: 'Slack', value: (d.slackMessages || []).length }
        ].filter((t) => this._isSectionVisible(t.section));
    }
    _appsToReview() {
        return ((this.data && this.data.applications) || []).filter((a) => this._appNeedsDecision(a));
    }
    // needs a decision: closes this month AND not yet auto/manually approved
    _appNeedsDecision(a) {
        if (!a.CloseDate || !this.data) return false;
        const thisMonth = String(this.data.asOfDate).slice(0, 7);
        const status = String(a.Status || '').toLowerCase();
        const approved = status === 'auto approved' || status === 'manually approved';
        return a.CloseDate.slice(0, 7) === thisMonth && !approved;
    }
    _appStatusTone(status) {
        const s = String(status || '').toLowerCase();
        if (s.indexOf('approved') > -1) return 'success';
        if (s === 'declined') return 'error';
        return 'neutral';
    }
    _overdueOpps() {
        const d = this.data || {};
        const today = d.asOfDate;
        const min = parseInt(this.opportunitiesMinAmount, 10) || 0;
        return (d.opportunities || []).filter(
            (o) =>
                !o.IsClosed &&
                o.CloseDate &&
                o.CloseDate < today &&
                (min <= 0 || (o.Amount != null && o.Amount >= min))
        );
    }
    _highCaseCount() {
        return this._filteredCases().filter(
            (x) => this._isHigh(x.Priority) || this._isEscalated(x.Status)
        ).length;
    }
    _isHigh(p) {
        return p && ['high', 'critical'].includes(String(p).toLowerCase());
    }
    _isEscalated(s) {
        return s && String(s).toLowerCase() === 'escalated';
    }

    // ---- sections ----
    get viewSections() {
        if (!this.data) return [];
        const d = this.data;
        const today = d.asOfDate;
        const built = [];

        const add = (key, hidden, label, accent, icon, columns, emptyText, rows) => {
            if (!this._isSectionVisible(key)) return;
            built.push(this._section(key, label, accent, icon, columns, emptyText, rows));
        };

        add('accounts', this.hideAccounts, 'Accounts That Need Attention', this.accentAccounts, 'utility:company',
            ['Account', 'Health', 'Risk Reason', 'Owner'], 'No at-risk accounts. Your book looks healthy.',
            this._filteredAccounts().map((a) => this._row('Account', a.Id, [
                this._link(a.Name, this._recUrl('Account', a.Id)),
                this._badge(a.HealthStatus, 'error'),
                this._text(a.RiskReason),
                this._text(a.Owner)
            ])));

        add('tasks', this.hideTasks, 'Top Tasks to Tackle First', this.accentTasks, 'utility:task',
            ['Task', 'Related To', 'Due', 'Priority', 'Status'], 'No open tasks. You are all caught up.',
            this._filteredTasks().map((t) => {
                const overdue = t.ActivityDate && t.ActivityDate < today;
                return this._row('Task', t.Id, [
                    this._link(t.Subject, this._recUrl('Task', t.Id), this._isHigh(t.Priority)),
                    this._text(t.RelatedTo),
                    this._text(fmtDate(t.ActivityDate), overdue ? 'due-flag' : '', t.ActivityDate || ''),
                    this._badge(t.Priority, this._isHigh(t.Priority) ? 'error' : 'neutral'),
                    this._text(t.Status)
                ]);
            }));

        add('cases', this.hideCases, 'Cases Requiring Your Attention', this.accentCases, 'utility:case',
            ['Case', 'Account', 'Priority', 'Status', 'Opened'], 'No open cases need your attention.',
            this._filteredCases().map((c) => {
                const hot = this._isHigh(c.Priority) || this._isEscalated(c.Status);
                const label = `${c.CaseNumber} — ${c.Subject}`;
                return this._row('Case', c.Id, [
                    this._link(label, this._recUrl('Case', c.Id), hot),
                    this._text(c.AccountName),
                    this._badge(c.Priority, this._isHigh(c.Priority) ? 'error' : 'neutral'),
                    this._badge(c.Status, this._isEscalated(c.Status) ? 'error' : 'neutral'),
                    this._text(fmtDate(c.CreatedDate), '', c.CreatedDate || '')
                ]);
            }));

        add('opportunities', this.hideOpportunities, 'Overdue Opportunities', this.accentOpportunities, 'utility:opportunity',
            ['Opportunity', 'Account', 'Amount', 'Stage', 'Close Date'], 'No overdue opportunities. Forecast is clean.',
            this._overdueOpps().map((o) => this._row('Opportunity', o.Id, [
                this._link(o.Name, this._recUrl('Opportunity', o.Id)),
                this._text(o.AccountName),
                this._text(o.Amount != null ? CURRENCY.format(o.Amount) : '—', 'amount', o.Amount != null ? o.Amount : -1),
                this._text(o.StageName),
                this._text(fmtDate(o.CloseDate), 'due-flag', o.CloseDate || '')
            ])));

        add('applications', this.hideApplications, 'Applications', this.accentApplications, 'utility:file',
            ['Application', 'Status', 'Amount', 'Close Date', 'Created'],
            'No pending applications to review.',
            this._filteredApplications().map((ap) => {
                const flag = this._appNeedsDecision(ap);
                return this._row('Application__c', ap.Id, [
                    this._link(`App # ${ap.ApplicationNumber || ap.Name}`, this._recUrl('Application__c', ap.Id), flag),
                    this._badge(ap.Status, this._appStatusTone(ap.Status)),
                    this._text(ap.Amount != null ? CURRENCY.format(ap.Amount) : '—', 'amount', ap.Amount != null ? ap.Amount : -1),
                    this._text(fmtDate(ap.CloseDate), flag ? 'due-flag' : '', ap.CloseDate || ''),
                    this._text(fmtDate(ap.Created), '', ap.Created || '')
                ], 'record', null, flag ? 'row-flag' : '');
            }));

        add('alerts', this.hideAlerts, 'Alerts & Mentions', this.accentAlerts, 'utility:notification',
            ['Alert', 'Related Record', 'Date', 'Type'], 'No alerts or approvals waiting on you.',
            (d.alerts || []).map((a) => this._row(a.RelatedObject, a.RelatedId, [
                this._text(a.Subject),
                a.RelatedId ? this._link('Open record', this._recUrl(a.RelatedObject, a.RelatedId)) : this._text('—'),
                this._text(fmtDate(a.Date), '', a.Date || ''),
                this._badge(a.Type, 'neutral')
            ], 'alert')));

        add('slack', this.hideSlack, 'Slack Messages', this.accentSlack, 'utility:chat',
            ['From', 'Channel', 'Message', 'Received'], 'No Slack messages need a reply.',
            [...this.localSwarms, ...(d.slackMessages || [])].map((m) => this._row(null, m.Id, [
                this._text(m.From, m.IsDirectMention ? 'strong' : ''),
                this._text(m.Channel),
                this._text(m.Preview),
                this._text(fmtDate(m.ReceivedDate), '', m.ReceivedDate || '')
            ], 'slack', m.ThreadUrl)));

        // apply search + sort + limit + collapse per section
        const term = this.searchTerm.trim().toLowerCase();
        return built.map((s) => this._finalizeSection(s, term));
    }

    _finalizeSection(s, term) {
        const rawCount = s.rows.length;
        const sTerm = (this.sectionSearch[s.key] || '').trim().toLowerCase();
        const colF = this.columnFilters[s.key] || {};
        const colFActive = Object.keys(colF).some((k) => (colF[k] || '').trim() !== '');

        const structCfg = STRUCTURED[s.key] || [];
        const structVals = this.structured[s.key] || {};
        const structActive = structCfg.some((f) => (structVals[f.id] || '') !== '');

        let rows = s.rows.filter((r) => {
            if (term && !r.cells.some((c) => String(c.text).toLowerCase().includes(term))) return false;
            if (sTerm && !r.cells.some((c) => String(c.text).toLowerCase().includes(sTerm))) return false;
            for (const ci of Object.keys(colF)) {
                const val = (colF[ci] || '').trim().toLowerCase();
                if (val) {
                    const cell = r.cells[Number(ci)];
                    if (!cell || !String(cell.text).toLowerCase().includes(val)) return false;
                }
            }
            for (const f of structCfg) {
                const v = structVals[f.id] || '';
                if (!v) continue;
                const cell = r.cells[f.col];
                if (!cell) return false;
                if (f.type === 'picklist' && cell.text !== v) return false;
                if (f.type === 'search' && !String(cell.text).toLowerCase().includes(v.toLowerCase())) return false;
                if (f.type === 'date' && (!cell.sort || String(cell.sort) > v)) return false;
            }
            return true;
        });
        const anyFilter = !!term || !!sTerm || colFActive || structActive;

        // build the structured filter controls (picklist options from actual data)
        const structuredControls = structCfg.map((f) => {
            const val = structVals[f.id] || '';
            let options;
            if (f.type === 'picklist') {
                const seen = [...new Set(s.rows
                    .map((r) => (r.cells[f.col] ? r.cells[f.col].text : ''))
                    .filter((t) => t && t !== '—'))].sort();
                options = [{ label: `All ${f.label}`, value: '' }].concat(
                    seen.map((t) => ({ label: t, value: t }))
                );
            }
            return {
                key: `${s.key}-f-${f.id}`,
                id: f.id,
                section: s.key,
                label: f.label,
                value: val,
                options,
                isPicklist: f.type === 'picklist',
                isDate: f.type === 'date',
                isSearch: f.type === 'search'
            };
        });
        const sort = this.sortState[s.key];
        if (sort) {
            const { col, dir } = sort;
            rows = [...rows].sort((a, b) => {
                const av = a.cells[col] ? a.cells[col].sort : '';
                const bv = b.cells[col] ? b.cells[col].sort : '';
                let r;
                if (typeof av === 'number' && typeof bv === 'number') r = av - bv;
                else r = String(av).localeCompare(String(bv));
                return dir === 'desc' ? -r : r;
            });
        }
        const total = rows.length;
        const shown = rows.slice(0, this._sectionLimit(s.key));
        const columns = s.headers.map((h, i) => {
            const active = sort && sort.col === i;
            const dirDesc = active && sort.dir === 'desc';
            return {
                key: `${s.key}-h${i}`,
                label: h,
                colIndex: String(i),
                section: s.key,
                isSorted: !!active,
                sortIcon: active ? (dirDesc ? 'utility:arrowdown' : 'utility:arrowup') : '',
                sortAlt: active ? (dirDesc ? 'Sorted descending' : 'Sorted ascending') : '',
                ariaSort: active ? (dirDesc ? 'descending' : 'ascending') : 'none',
                filterValue: colF[i] || '',
                filterLabel: `Filter by ${h}`
            };
        });
        const isCollapsed = !!this.collapsed[s.key] && !anyFilter;
        const isFilterOpen = !!this.filtersOpen[s.key];
        return {
            ...s,
            columns,
            rows: shown,
            count: total,
            rawCount,
            isEmpty: total === 0,
            noMatches: total === 0 && rawCount > 0,
            emptyMessage: total === 0 && rawCount > 0 ? 'No records match your filters.' : s.emptyText,
            showToolbar: rawCount > 0,
            isFilterOpen,
            filterBtnVariant: isFilterOpen ? 'brand' : 'border-filled',
            hasStructured: structuredControls.length > 0,
            structuredControls,
            sectionSearchValue: this.sectionSearch[s.key] || '',
            isCollapsed,
            ariaExpanded: String(!isCollapsed),
            regionId: `sec-body-${s.key}`,
            chevron: isCollapsed ? 'utility:chevronright' : 'utility:chevrondown',
            truncated: total > shown.length,
            moreCount: total - shown.length,
            limit: shown.length
        };
    }

    // builders
    _section(key, label, accent, icon, headers, emptyText, rows) {
        return { key, label, icon, headers, emptyText, rows, style: `--accent:${accent};` };
    }
    _row(objectApiName, id, cells, kind = 'record', externalUrl = null, rowClass = '') {
        return {
            key: `${objectApiName || 'x'}-${id}`,
            id,
            objectApiName,
            externalUrl,
            rowClass,
            isRecord: kind === 'record',
            isAlert: kind === 'alert',
            isSlack: kind === 'slack',
            isCaseRow: objectApiName === 'Case' && kind === 'record',
            isAppRow: objectApiName === 'Application__c' && kind === 'record',
            cells: cells.map((c, i) => ({ ...c, key: `${id}-c${i}` }))
        };
    }
    _text(value, cls = '', sort = null) {
        const text = value != null && value !== '' ? value : '—';
        return { isText: true, text, cls, sort: sort != null ? sort : String(text).toLowerCase() };
    }
    _badge(value, tone) {
        const text = value || '—';
        return { isBadge: true, text, badgeClass: `pill pill_${tone}`, sort: String(text).toLowerCase() };
    }
    _link(text, href, strong = false) {
        const t = text || '—';
        return { isLink: true, text: t, href, cls: strong ? 'strong' : '', sort: String(t).toLowerCase() };
    }
    _recUrl(obj, id) {
        return `/lightning/r/${obj}/${id}/view`;
    }

    // ---- events ----
    handleRefresh() {
        this.load();
    }
    handleScopeChange(event) {
        this.scope = event.target.checked ? 'engagement' : 'owner';
        this.load();
    }
    handleSearch(event) {
        this.searchTerm = event.target.value || '';
    }
    handleMode(event) {
        this.businessMode = event.detail.value;
    }
    toggleCollapse(event) {
        const key = event.currentTarget.dataset.key;
        this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] };
    }
    handleHeaderKey(event) {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            this.toggleCollapse(event);
        }
    }
    handleSort(event) {
        const section = event.currentTarget.dataset.section;
        const col = parseInt(event.currentTarget.dataset.col, 10);
        const cur = this.sortState[section];
        let dir = 'asc';
        if (cur && cur.col === col) dir = cur.dir === 'asc' ? 'desc' : 'asc';
        this.sortState = { ...this.sortState, [section]: { col, dir } };
    }
    handleSectionSearch(event) {
        const key = event.currentTarget.dataset.key;
        this.sectionSearch = { ...this.sectionSearch, [key]: event.target.value || '' };
    }
    toggleFilters(event) {
        const key = event.currentTarget.dataset.key;
        const open = !this.filtersOpen[key];
        this.filtersOpen = { ...this.filtersOpen, [key]: open };
        if (!open) {
            // clear this section's column filters when hiding the row
            this.columnFilters = { ...this.columnFilters, [key]: {} };
        }
    }
    handleColumnFilter(event) {
        const key = event.currentTarget.dataset.section;
        const col = event.currentTarget.dataset.col;
        const forKey = { ...(this.columnFilters[key] || {}), [col]: event.target.value || '' };
        this.columnFilters = { ...this.columnFilters, [key]: forKey };
    }
    handleStructured(event) {
        const { section, filter } = event.currentTarget.dataset;
        const val = event.detail && event.detail.value !== undefined
            ? event.detail.value
            : event.target.value;
        const forKey = { ...(this.structured[section] || {}), [filter]: val || '' };
        this.structured = { ...this.structured, [section]: forKey };
    }

    handleRowAction(event) {
        const action = event.detail.value;
        const { id, object } = event.currentTarget.dataset;
        switch (action) {
            case 'view':
                this._navigate(id, object, 'view');
                break;
            case 'edit':
                this._navigate(id, object, 'edit');
                break;
            case 'delete':
                this._delete(id);
                break;
            case 'assign':
                this._openAssign(id);
                break;
            case 'swarm':
                this._initiateSwarm(id);
                break;
            case 'teams':
                this._escalateTeams(id);
                break;
            case 'approve':
                this._approveApplication(id);
                break;
            default:
                break;
        }
    }

    async _initiateSwarm(caseId) {
        const swarmId = `swarm-${caseId}`;
        if (this.localSwarms.some((s) => s.Id === swarmId)) {
            this._toast('Swarm exists', 'A swarm is already open for this case.', 'info');
            return;
        }
        try {
            const res = await initiateSlackSwarm({ caseId });
            this.localSwarms = [
                {
                    Id: swarmId,
                    From: `Swarm · ${this.userName || 'You'}`,
                    Channel: res.channel,
                    Preview: `Swarm started for case ${res.caseNumber} — ${res.subject}`,
                    ReceivedDate: this.data.asOfDate,
                    ThreadUrl: res.threadUrl,
                    IsDirectMention: true
                },
                ...this.localSwarms
            ];
            const note = res.simulated ? ' (simulated — enable Slack to post for real)' : '';
            this._toast('Swarm started', `${res.channel} created for case ${res.caseNumber}.${note}`, 'success');
        } catch (e) {
            this._toast('Swarm failed', this._msg(e), 'error');
        }
    }
    async _approveApplication(appId) {
        const ok = await LightningConfirm.open({
            message: 'Approve this application? Its Decision Status will be set to "Manually Approved".',
            label: 'Approve application',
            theme: 'warning'
        });
        if (!ok) return;
        try {
            await updateRecord({ fields: { Id: appId, Decision_Status__c: 'Manually Approved' } });
            this._toast('Approved', 'Application set to Manually Approved.', 'success');
            this.load();
        } catch (e) {
            this._toast('Approve failed', this._msg(e), 'error');
        }
    }
    async _escalateTeams(caseId) {
        // launch the Escalation_to_Teams screen flow, passing the case as recordId
        await FlowLauncherModal.open({
            size: 'medium',
            label: 'Escalate to Teams',
            flowApiName: TEAMS_FLOW,
            recordId: caseId
        });
    }

    _navigate(recordId, objectApiName, mode) {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId, objectApiName, actionName: mode }
        });
    }

    async _delete(recordId) {
        const ok = await LightningConfirm.open({
            message: 'Delete this record? This cannot be undone.',
            label: 'Delete record',
            theme: 'error'
        });
        if (!ok) return;
        try {
            await deleteRecord(recordId);
            this._toast('Deleted', 'Record deleted.', 'success');
            this.load();
        } catch (e) {
            this._toast('Delete failed', this._msg(e), 'error');
        }
    }

    async _openAssign(recordId) {
        // lightning-modal handles focus trap, Escape, and focus restore for us
        const newOwnerId = await AssignOwnerModal.open({
            size: 'small',
            label: 'Assign new owner'
        });
        if (!newOwnerId) return;
        try {
            await updateRecord({ fields: { Id: recordId, OwnerId: newOwnerId } });
            this._toast('Reassigned', 'Owner updated.', 'success');
            this.load();
        } catch (e) {
            this._toast('Reassign failed', this._msg(e), 'error');
        }
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
    _msg(e) {
        return (e && e.body && e.body.message) || 'Something went wrong.';
    }
}
