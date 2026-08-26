/* ==========================================================================
   CCLD 演示站 — 渲染与交互（vanilla JS，无依赖）
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const EXIT_LABEL = {
  promo: '晋升', lateral: '平调', retire: '退二线', purge: '落马', incumbent: '在任',
  formal: '转正', resign: '辞职', dismiss: '免职/撤职', unknown: '待查', point: '在任年点',
};
const EXIT_COLOR = {
  promo: 'var(--seal)', lateral: 'var(--ochre)', retire: 'var(--retire)',
  purge: 'var(--purge)', incumbent: 'var(--indigo)',
  formal: 'var(--indigo)', resign: '#7d6754', dismiss: '#7d6754', unknown: '#9a948a',
  point: '#9a948a',
};
// 到任来源方向（与离任去向对称的分类，由履历推导）
const ORIGIN_COLOR = {
  local: 'var(--seal)', lateral: 'var(--ochre)', descend: 'var(--indigo)',
  acting: '#7d6754', formal: '#5b7287', unknown: '#9a948a',
};

let state = {
  loc: { level: 'nation' },   // 当前层级定位（见 locFromArg）
};
const ROUTE_NAMES = new Set(['home', 'browse', 'person', 'reviews', 'download', 'registry']);

// 职位名称按层级 + 县域类型适配（省/地级市/市辖区/县级市/县）
function postTitles(c) {
  if (c.level === 'province') return { sec: '中共省委书记', mayor: '省长', secShort: '书记', mayorShort: '省长' };
  if (c.level === 'prefecture') return { sec: '中共市委书记', mayor: '市长', secShort: '书记', mayorShort: '市长' };
  if (c.type === '市辖区') return { sec: '中共区委书记', mayor: '区长', secShort: '书记', mayorShort: '区长' };
  if (c.type === '县级市') return { sec: '中共市委书记', mayor: '市长', secShort: '书记', mayorShort: '市长' };
  return { sec: '中共县委书记', mayor: '县长', secShort: '书记', mayorShort: '县长' };
}

/* ===================== 路由 ===================== */
function route() {
  const hash = location.hash || '#/home';
  const [, view, arg] = hash.split('/');
  const name = ROUTE_NAMES.has(view) ? view : 'home';

  if (name === 'person' && arg) renderPerson(arg);
  if (name === 'browse') {
    state.loc = locFromArg(arg);
    renderBrowse();
  }
  if (name === 'reviews') renderReviews();
  $$('.view').forEach(v => v.classList.remove('is-active'));
  const target = $(`#view-${name}`) || $('#view-home');
  target.classList.add('is-active');

  $$('.topnav a').forEach(a => a.classList.toggle(
    'is-active', a.dataset.nav === (name === 'person' ? 'browse' : name)));
  window.scrollTo({ top: 0, behavior: 'instant' });
}
window.addEventListener('hashchange', route);

/* ===================== 审核与裁决（#/reviews） =====================
   数据：DB.reviews（review_queue ∪ resolutions ∪ 裁决卡，build_demo_data.py 生成）。
   状态五态与徽标配色：pending 未决·灰 / auto 规则自动·蓝 / human 人工裁定·绿 /
   backlog 挂账·黄 / suggested 待确认裁决卡·橙。 */
const RV_STATUS = {
  pending:   { icon: '◻', label: '未决', cls: 'rv-pending' },
  suggested: { icon: '◈', label: '待确认', cls: 'rv-suggested' },
  auto:      { icon: '⚙', label: '规则自动', cls: 'rv-auto' },
  human:     { icon: '✓', label: '人工裁定', cls: 'rv-human' },
  backlog:   { icon: '◔', label: '挂账', cls: 'rv-backlog' },
};
const RV_RANK = { suggested: 0, pending: 1, human: 2, auto: 3, backlog: 4 };
const RV_PAGE_SIZE = 50;   // 分页渲染：2700+ 卡一次性渲染会卡顿
let rvInited = false;
let rvPage = 1;
const RV_ADJUDICATOR_KEY = 'ccld.adjudicator';

const escHTML = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escLines = s => escHTML(s).replace(/\r\n?|\n/g, '<br>');
function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
const clampRatio = value => Math.max(0, Math.min(1, finiteNumber(value)));
function safeExternalHref(url) {
  const raw = String(url == null ? '' : url).trim();
  return /^https?:\/\//i.test(raw) && !/[\u0000-\u001f\u007f]/.test(raw) ? escHTML(raw) : '';
}
function snapshotHref(snap, q = '') {
  const path = `snapshots/${encodeURIComponent(String(snap == null ? '' : snap))}`;
  return escHTML(path + (q ? `?q=${encodeURIComponent(String(q))}` : ''));
}

// 裁决卡三态选择暂存（localStorage，键含 review_id）；无 warning 的卡默认预选〔采纳〕
const rvDecKey = id => 'ccld.rvdec.' + id;
function rvGetDecision(r) {
  let v = null;
  try { v = localStorage.getItem(rvDecKey(r.id)); } catch (e) { /* 隐私模式等场景不可用 */ }
  if (v === 'adopt' || v === 'reject' || v === 'human') return v;
  return (r.card && !(r.card.warnings || []).length) ? 'adopt' : null;
}
function rvSetDecision(id, v) {
  try { localStorage.setItem(rvDecKey(id), v); } catch (e) { /* 同上，静默降级为不暂存 */ }
}

function rvGetAdjudicator() {
  const el = $('#rv-adjudicator');
  return (el ? el.value : '').trim();
}

function rvRequireAdjudicator() {
  const name = rvGetAdjudicator();
  if (name) return name;
  const el = $('#rv-adjudicator');
  alert('请先填写“本次裁决人”。姓名会随导出文件永久写入裁决记录。');
  if (el) el.focus();
  return '';
}

// 流程条：采集 → codex 复核 → 规则自动 → 人工确认 → 落地（五态计数徽标）
function rvFlowHTML(stats) {
  const by = (stats && stats.byStatus) || {};
  const n = s => Math.max(0, Math.trunc(finiteNumber(by[s])));
  const total = Object.keys(RV_STATUS).reduce((sum, status) => sum + n(status), 0);
  const badge = s => `<span class="rv-badge rv-b-${s}">${RV_STATUS[s].icon} ${RV_STATUS[s].label} ${n(s)}</span>`;
  const steps = [
    ['采集', `<span class="rv-badge rv-b-total">争议 ${total}</span>`, '采集/装配阶段登记的全部争议台账'],
    ['codex 复核', badge('pending'), '未决——待 codex 复核 / 规则 / 人工处置'],
    ['规则自动', badge('auto'), '文书性规则自动裁决（resolution 含 auto:）'],
    ['人工确认', badge('suggested'), '机器已备齐库内互证依据出裁决卡，待人工〔采纳/驳回/转人工〕后导出确认'],
    ['落地', badge('human') + badge('backlog'), '人工/codex 裁定落档；挂账 = 诚实措辞挂账关闭（数据不动、可重开）'],
  ];
  return steps.map(([t, b, tip], i) =>
    `${i ? '<span class="rv-flow-arrow">→</span>' : ''}` +
    `<span class="rv-flow-step" title="${escHTML(tip)}"><b>${t}</b>${b}</span>`).join('');
}

// suggested 态裁决卡：A/B 分歧、机器建议侧+值、锚点依据、护栏核对项、warnings 黄标、三态单选
function rvCardHTML(r) {
  const c = r.card;
  if (!c) return '';
  const dec = rvGetDecision(r);
  const radio = (v, lab) => `<label class="rv-dec-opt"><input type="radio" name="rvdec-${escHTML(r.id)}"
    value="${v}" data-rvdec="${escHTML(r.id)}"${dec === v ? ' checked' : ''}> ${lab}</label>`;
  return `<div class="rv-card">
    <div class="rv-card-hd">裁决卡 · ${escHTML(c.rule) || '—'}${c.kind ? ' · ' + escHTML(c.kind) : ''}${
      c.actionType ? `<span class="rv-card-action">${escHTML(c.actionType)}</span>` : ''}</div>
    <div class="rv-ab">
      <span class="rv-ab-val${c.side === 'A' ? ' is-suggested' : ''}">A：${escHTML(c.a) || '—'}</span>
      <span class="rv-ab-vs">vs</span>
      <span class="rv-ab-val${c.side === 'B' ? ' is-suggested' : ''}">B：${escHTML(c.b) || '—'}</span>
      <span class="rv-ab-pick">机器建议：${c.side ? escHTML(c.side) + ' 侧' : '—'}${c.value ? ' → ' + escHTML(c.value) : ''}</span>
    </div>
    ${c.anchor ? `<p class="rv-anchor"><b>锚点依据</b>：${escHTML(c.anchor)}</p>` : ''}
    ${(c.checks || []).length ? `<ul class="rv-checks">${c.checks.map(x => `<li>✓ ${escHTML(x)}</li>`).join('')}</ul>` : ''}
    ${(c.warnings || []).length ? `<div class="rv-warnings">${c.warnings.map(x => `<p>⚠ ${escHTML(x)}</p>`).join('')}
      <p class="rv-warn-note">有警示的卡默认不预选，请人工核对后再选。</p></div>` : ''}
    <div class="rv-decide">${radio('adopt', '采纳')}${radio('reject', '驳回')}${radio('human', '转人工')}</div>
  </div>`;
}

// ---- 人工裁决：case 对比卡（A/B 两条组装路线 + 直接证据/间接锚点 + 前后时间轴） ----
// 选择暂存 localStorage「rvjudge:<rowKey>」={action,value,note}；rowKey 可隔离历史重复 review_id。
const rvItemKey = r => r.rowKey || r.id;
function rvJudgeKey(id) { return 'rvjudge:' + id; }
function rvGetJudge(id) {
  try { const v = localStorage.getItem(rvJudgeKey(id)); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
function rvSetJudge(id, patch) {
  const cur = rvGetJudge(id) || { action: '', value: '', note: '' };
  Object.assign(cur, patch);
  try {
    if (!cur.action) localStorage.removeItem(rvJudgeKey(id));
    else localStorage.setItem(rvJudgeKey(id), JSON.stringify(cur));
  } catch (e) { /* 隐私模式静默降级 */ }
}

let rvPersonIndex = null;
function rvPersonHTML(name, cls = '') {
  if (!name) return '—';
  if (!rvPersonIndex) {
    rvPersonIndex = new Map();
    Object.entries(DB.persons || {}).forEach(([pid, p]) => {
      if (!p || !p.name) return;
      rvPersonIndex.set(p.name, rvPersonIndex.has(p.name) ? null : pid); // 同名多人不贸然链接
    });
  }
  const pid = rvPersonIndex.get(name);
  return pid
    ? `<a class="${cls}" href="#/person/${encodeURIComponent(pid)}">${escHTML(name)}</a>`
    : `<span class="${cls}">${escHTML(name)}</span>`;
}

const RV_SUPPORT = {
  direct: ['本人直接证据', 'rv-support-direct'],
  direct_mismatch: ['登记为直接·引文异常', 'rv-support-mismatch'],
  indirect: ['仅有交接锚点', 'rv-support-anchor'],
  related: ['仅有相关记录', 'rv-support-related'],
  none: ['未找到支撑记录', 'rv-support-none'],
};

function rvSupportHTML(side) {
  const x = RV_SUPPORT[(side && side.support) || 'none'] || RV_SUPPORT.none;
  return `<span class="rv-support ${x[1]}">${x[0]}</span>`;
}

function rvEvidenceItemHTML(e) {
  const tier = String(e.tier || '');
  const tierClass = /^[A-D]$/.test(tier) ? tier : 'x';
  const sourceHref = safeExternalHref(e.url);
  const source = sourceHref
    ? `<a class="src-chip tier-${tierClass}" href="${sourceHref}" target="_blank" rel="noopener">
        <span class="tier-badge">${escHTML(tier || '?')}</span>${escHTML(e.title || e.url || '未命名来源')}</a>`
    : `<span class="src-chip tier-${tierClass}"><span class="tier-badge">${escHTML(tier || '?')}</span>${escHTML(e.title || '未命名来源')}</span>`;
  const roleCls = e.role === 'direct' ? 'is-direct' : (e.role === 'anchor' ? 'is-anchor' : 'is-related');
  return `<article class="rv-ev ${roleCls}">
    <div class="rv-ev-top">
      <span class="rv-evidence-role ${roleCls}">${escHTML(e.roleLabel || '相关记录')}</span>
      ${source}
    </div>
    <p class="rv-ev-claimline"><span>登记事实</span>
      ${rvPersonHTML(e.person, 'rv-ev-person')} · ${escHTML(e.claim || '未标类型')}${e.value ? ' · <b>' + escHTML(e.value) + '</b>' : ''}
      ${e.id ? `<code title="正式 evidence_id">${escHTML(e.id)}</code>` : ''}
    </p>
    <blockquote class="rv-quote">「${escLines(e.quote || '（无引文）')}」</blockquote>
    ${e.quoteTargetMismatch
      ? `<p class="rv-evidence-warning">⚠ 结构化字段称这是本人直接证据，但引文没有出现争议人物姓名；不能仅凭此条作出裁决。</p>`
      : ''}
    <div class="rv-ev-links">
      ${sourceHref ? `<a href="${sourceHref}" target="_blank" rel="noopener">打开原文 ↗</a>` : '<span class="dim">无可用原文链接</span>'}
      ${e.snap ? `<a href="${snapshotHref(e.snap, e.q)}" target="_blank" rel="noopener">打开采集快照 ↗</a>` : '<span class="dim">无本地快照</span>'}
      ${e.date ? `<span>采集 ${escHTML(e.date)}</span>` : ''}
    </div>
  </article>`;
}

function rvSideHTML(side, label) {
  const items = (side && side.items) || [];
  const counts = (side && side.counts) || {};
  const body = items.length
    ? items.map(rvEvidenceItemHTML).join('')
    : `<div class="rv-noev">
        <b>正式证据库中没有找到能解释这个值的记录。</b>
        <span>它可能来自模型推断、尚未正式化的临时证据号，或已经在校验中作废的证据；不能把“路线产出了一个值”当成“该值已有证据”。</span>
      </div>`;
  const refs = (side && side.routeRefs) || [];
  const count = key => Math.max(0, Math.trunc(finiteNumber(counts[key])));
  return `<div class="rv-side">
    <div class="rv-side-hd">
      <div><span class="rv-route-label">${label} 路组装结论</span><b>${escHTML((side && side.value) || '—')}</b></div>
      ${rvSupportHTML(side)}
    </div>
    <p class="rv-side-count">本人直接 ${count('direct')} 条 · 交接锚点 ${count('anchor')} 条 · 其他相关 ${count('related')} 条</p>
    ${body}
    ${refs.length ? `<details class="rv-route-refs">
      <summary>查看该路线原始挂接的 ${refs.length} 个证据号</summary>
      <p>${refs.map(x => `<code>${escHTML(x)}</code>`).join(' ')}</p>
      <small>临时号不一定能反查正式 evidence.csv；上方可点击卡片来自正式证据库。</small>
    </details>` : ''}
  </div>`;
}

function rvContextNode(x, kind) {
  if (!x) return '<span class="rv-tl-empty">未找到相邻任期</span>';
  const date = kind === 'prev' ? `至 ${x.end || '?'}` : `自 ${x.start || '?'}`;
  return `<span class="rv-tl-node">${rvPersonHTML(x.person)}<small>${escHTML(date)}</small></span>`;
}

function rvCaseHTML(r) {
  const c = r.case;
  if (!c) return '';
  const ctx = c.context || {};
  const sides = (c.a && c.a.value) || (c.b && c.b.value)
    ? `<div class="rv-sides">${rvSideHTML(c.a, 'A')}${rvSideHTML(c.b, 'B')}</div>` : '';
  return `<div class="rv-case">
    <div class="rv-case-head">
      <div>
        <span class="rv-case-kicker">两条独立组装路线的结论</span>
        <div class="rv-case-point">${escHTML(c.point || '—')}${(c.point === '到任' || c.point === '离任') ? '时间' : ''}</div>
      </div>
      <p><b>A/B 是组装路线，不是信源等级。</b>证据卡左侧的 A、B、C 才是来源等级。</p>
    </div>
    ${sides}
    <div class="rv-context">
      <span class="rv-context-label">放回时间轴检查交接</span>
      <div class="rv-timeline">
      ${rvContextNode(ctx.prev, 'prev')}
      <span class="rv-tl-arrow">→</span>
      <span class="rv-tl-self"><small>本次要裁</small>${rvPersonHTML(c.person || r.person || '?')}</span>
      <span class="rv-tl-arrow">→</span>
      ${rvContextNode(ctx.next, 'next')}
      </div>
    </div>
  </div>`;
}

function rvGenericQuestion(r) {
  const who = r.person ? `${r.person}的` : '';
  const map = {
    '时间轴空洞': `请决定：是否暂时接受这段时间轴空缺，还是继续补采后再裁？`,
    '同名消歧': `请决定：${r.person || '这两条人物记录'}是否为同一个人？`,
    '引文校验失败': `请决定：是否剔除这条无法在快照中逐字核验的证据？`,
    '县名歧义': `请决定：这条记录应归属哪个行政单位？`,
    '沿革无官方依据': `请决定：该沿革事件是否继续挂账等待官方依据？`,
    '单位未完成': `请决定：是否维持未完成状态并安排重跑？`,
    '多源矛盾': `请确定：${who || '这项'}冲突事实应采用哪个版本？`,
  };
  return map[r.type] || `请决定：这条${r.type || '争议'}记录应如何处理？`;
}

function rvBriefHTML(r) {
  const c = r.case;
  const question = (c && c.question) || rvGenericQuestion(r);
  let impact = '裁决只会形成可审计的 resolution；事实数据需按原批次重新 merge 后才会生效。';
  if (c && c.state === 'rescued') {
    impact = '当前已有一条保守任期段写入数据，裁决后将按所选结论修订端点或代理属性。';
  } else if (c) {
    impact = '两条路线没有达成一致，这一争议段可能尚未写入正式任期表，并会在时间轴上形成空缺。';
  }
  return `<section class="rv-brief" aria-label="本条裁决问题">
    <span>你只需要回答一个问题</span>
    <h3>${escHTML(question)}</h3>
    <p>${escHTML(impact)}</p>
    ${r.idCollision ? `<p class="rv-id-warning">⚠ 此 <code>review_id</code> 曾被重复发号。页面已按内容指纹隔离，不会再把另一事项的裁决套到本条。</p>` : ''}
  </section>`;
}

function rvMentionedHTML(c) {
  const items = (c && c.mentioned) || [];
  if (!items.length) return '';
  return `<div class="rv-mentioned"><span>复核意见提到：</span>${items.map(e => {
    const href = e.snap
      ? snapshotHref(e.snap, e.q)
      : safeExternalHref(e.url);
    return href
      ? `<a href="${href}" target="_blank" rel="noopener"><b>${escHTML(e.tier || '?')}</b> ${escHTML(e.id)} ↗</a>`
      : `<code>${escHTML(e.id)}</code>`;
  }).join('')}</div>`;
}

function rvAiHTML(r) {
  if (!r.ai) return '';
  return `<aside class="rv-ai">
    <div><b>机器复核意见</b><span>供参考，不是最终裁决</span></div>
    <p>${escHTML(r.ai)}</p>
    ${rvMentionedHTML(r.case)}
  </aside>`;
}

function rvJudgeHTML(r) {
  if (r.status !== 'pending') return '';
  const key = rvItemKey(r);
  const j = rvGetJudge(key) || {};
  const hasAB = !!(r.case && (r.case.a.value || r.case.b.value || r.case.point === '代理标记'));
  const canAdopt = side => !!(side && side.canAdopt);
  const sideLab = (s, x) => (s && s.value)
    ? `采用 ${x} 路结论：${escHTML(s.value)}${canAdopt(s) ? '' : '（无本人直接证据）'}`
    : `采用 ${x} 路变体`;
  const radio = (v, lab, disabled = false) => `<label class="rv-dec-opt${disabled ? ' is-disabled' : ''}"><input type="radio" name="rvj-${escHTML(key)}"
    value="${v}" data-rvj="${escHTML(key)}"${j.action === v ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${lab}</label>`;
  const opts = hasAB
    ? radio('adopt_a', sideLab(r.case.a, 'A'), !canAdopt(r.case.a))
      + radio('adopt_b', sideLab(r.case.b, 'B'), !canAdopt(r.case.b))
      + radio('both_wrong', '两路都不对，填写正确值')
      + radio('shelve', '暂不裁决，保持未决')
      + radio('backlog', '挂账待补，关闭本轮')
    : radio('shelve', '暂不裁决，保持未决')
      + radio('backlog', '挂账待补，关闭本轮')
      + radio('custom', '填写自定义裁决');
  const needVal = j.action === 'both_wrong' || j.action === 'custom';
  const ph = j.action === 'custom' ? '裁决结论（必填）' : '正确值（必填）';
  return `<div class="rv-actions">
    <div class="rv-actions-head"><b>作出裁决</b><span>先核对上方引文是否真的支持“登记事实”，再选择。</span></div>
    ${r.case && r.case.requiresEvidence ? `<div class="rv-evidence-guard">
      <b>当前不能采纳 A 或 B。</b>
      两侧都没有通过校验的本人直接证据；交接锚点只能说明相邻人物何时到任。建议选择“挂账待补”，并写明要补的官方任免材料。
    </div>` : ''}
    <div class="rv-decide">${opts}</div>
    <label class="rv-field${needVal ? '' : ' is-disabled'}"><span>${ph}</span>
    <input type="text" class="rv-jval" data-rvj-val="${escHTML(key)}" placeholder="${ph}"
      value="${escHTML(j.value || '')}"${needVal ? '' : ' disabled'}></label>
    <label class="rv-field"><span>裁决理由 / 待补方向（建议填写）</span>
      <textarea class="rv-jnote" data-rvj-note="${escHTML(key)}" rows="2"
        placeholder="例如：B 路引文未出现目标人物；需补省委免职文件">${escHTML(j.note || '')}</textarea></label>
  </div>`;
}

function rvSummaryText(r) {
  const c = r.case;
  if (c && (c.a.value || c.b.value)) {
    const who = c.person || r.person || '本段';
    return `${who} · ${c.point}${c.point === '到任' || c.point === '离任' ? '时间' : ''}：${c.a.value || '—'} / ${c.b.value || '—'}`;
  }
  return r.desc || r.type || '待裁决事项';
}

function rvItemHTML(r) {
  const status = Object.hasOwn(RV_STATUS, r.status) ? r.status : 'pending';
  const st = RV_STATUS[status];
  const c = r.uid ? byUid[r.uid] : null;
  const unit = r.uid
    ? `<a href="${escHTML('#/browse/' + r.uid)}">${escHTML(c ? c.name : r.unitName)}</a>`
    : escHTML(r.unitName || '未定位');
  return `<details class="rv-item ${st.cls}">
    <summary>
      <span class="rv-badge rv-b-${status}">${st.icon} ${st.label}</span>
      <span class="rv-type">${escHTML(r.type) || '—'}</span>
      <span class="rv-summary-main">
        <span class="rv-summary-question">${escHTML(rvSummaryText(r))}</span>
        <span class="rv-who">${unit}${r.post ? ' · ' + escHTML(r.post) : ''}</span>
      </span>
      <span class="rv-id">${escHTML(r.id)}${r.run ? ' · ' + escHTML(r.run) : ''}</span>
    </summary>
    <div class="rv-body">
      ${rvBriefHTML(r)}
      ${rvCaseHTML(r)}
      ${rvAiHTML(r)}
      ${r.resolution
        ? `<p class="rv-res"><b>最终裁决</b>${r.date || r.adjudicator
          ? '（' + [r.date, r.adjudicator ? '裁决人：' + r.adjudicator : '裁决人未记录'].filter(Boolean).map(escHTML).join(' · ') + '）'
          : ''}：${escHTML(r.resolution)}</p>`
        : ''}
      ${rvCardHTML(r)}
      ${rvJudgeHTML(r)}
      <details class="rv-raw">
        <summary>查看原始争议记录、批次与编号</summary>
        <dl>
          <div><dt>原始描述</dt><dd>${escHTML(r.desc) || '—'}</dd></div>
          <div><dt>review_id</dt><dd><code>${escHTML(r.id)}</code></dd></div>
          <div><dt>runId</dt><dd><code>${escHTML(r.run) || '—'}</code></dd></div>
        </dl>
      </details>
    </div>
  </details>`;
}

function rvSort(list) {
  return list.sort((a, b) => (RV_RANK[a.status] - RV_RANK[b.status])
    || b.run.localeCompare(a.run) || a.id.localeCompare(b.id));
}

function rvFiltered() {
  const fs = $('#rv-f-status').value, ft = $('#rv-f-type').value,
    fr = $('#rv-f-run').value, q = $('#rv-f-q').value.trim();
  return (DB.reviews || []).filter(r =>
    (!fs || r.status === fs || (fs === 'todo' && (r.status === 'pending' || r.status === 'suggested')))
    && (!ft || r.type === ft) && (!fr || r.run === fr)
    && (!q || [r.id, r.run, r.uid, r.unitName, r.person, r.post, r.desc, r.ai, r.resolution]
      .join(' ').includes(q)));
}

// 导出确认结果：全部已选择（含无 warning 卡的默认预选〔采纳〕）打包 JSON Blob 下载，
// 供 scripts/suggest_truncations.py --apply-confirmed 消费。
function rvExportConfirmations() {
  const sugg = (DB.reviews || []).filter(r => r.status === 'suggested');
  if (!sugg.length) { alert('当前没有待确认的裁决卡（suggested 态）。'); return; }
  const decisions = sugg
    .map(r => ({ review_id: r.id, decision: rvGetDecision(r), comment: '' }))
    .filter(d => d.decision);
  if (!decisions.length) { alert('尚未对任何裁决卡做出选择。'); return; }
  const adjudicator = rvRequireAdjudicator();
  if (!adjudicator) return;
  const payload = {
    generated_from: (DB.reviewStats && DB.reviewStats.suggestionsFile) || '',
    exported_at: new Date().toISOString(),
    adjudicator,
    decisions,
  };
  const d = new Date(), pad = x => String(x).padStart(2, '0');
  const fname = `truncation_confirmations_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  alert(`已导出 ${decisions.length} 条确认结果，裁决人：${adjudicator}。\n\n下一步运行：\npy scripts/suggest_truncations.py --date YYYY-MM-DD --apply-confirmed <导出的JSON> --apply`);
}

// 裁决进度：已填动作的未决数 / 未决总数
function rvJudgeProgress() {
  const el = $('#rv-judge-progress');
  if (!el) return;
  const pend = (DB.reviews || []).filter(r => r.status === 'pending');
  const done = pend.filter(r => { const j = rvGetJudge(rvItemKey(r)); return j && j.action; }).length;
  el.textContent = pend.length ? `裁决进度：已选 ${done} / 未决 ${pend.length}` : '';
}

// 导出人工裁决：pending 已填动作项 → JSON（供 scripts/apply_adjudications.py 消费）。
// 皆误/自由填写缺必填值（正确值/结论）的行 alert 列出并跳过。
function rvExportJudge() {
  const pend = (DB.reviews || []).filter(r => r.status === 'pending');
  const skipped = [], decisions = [];
  pend.forEach(r => {
    const j = rvGetJudge(rvItemKey(r));
    if (!j || !j.action) return;
    if (j.action === 'adopt_a' && !(r.case && r.case.a && r.case.a.canAdopt)) {
      skipped.push(`${r.id}（A 路无本人直接证据）`); return;
    }
    if (j.action === 'adopt_b' && !(r.case && r.case.b && r.case.b.canAdopt)) {
      skipped.push(`${r.id}（B 路无本人直接证据）`); return;
    }
    if ((j.action === 'both_wrong' || j.action === 'custom') && !(j.value || '').trim()) {
      skipped.push(r.id); return;
    }
    const d = { review_id: r.id, review_key: r.reviewKey || '', action: j.action };
    if ((j.value || '').trim()) d.value = j.value.trim();
    if ((j.note || '').trim()) d.note = j.note.trim();
    decisions.push(d);
  });
  if (skipped.length) alert('以下条目缺正确值/结论，已跳过：\n' + skipped.join('、'));
  if (!decisions.length) { alert('尚未对任何未决项做出裁决。'); return; }
  const adjudicator = rvRequireAdjudicator();
  if (!adjudicator) return;
  const payload = {
    generated_from: 'reviews-judge',
    exported_at: new Date().toISOString(),
    adjudicator,
    decisions,
  };
  const d0 = new Date(), pad = x => String(x).padStart(2, '0');
  const fname = `adjudications_${d0.getFullYear()}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  alert(`已导出 ${decisions.length} 条人工裁决，裁决人：${adjudicator}。\n\n下一步先预览：\npy scripts/apply_adjudications.py <导出的JSON>\n\n确认无误后正式落档：\npy scripts/apply_adjudications.py <导出的JSON> --apply`);
}

function renderReviews() {
  const all = DB.reviews || [];
  if (!rvInited) {
    rvInited = true;
    const opts = vals => vals.map(t => `<option value="${escHTML(t)}">${escHTML(t)}</option>`).join('');
    $('#rv-f-type').innerHTML = '<option value="">全部类型</option>'
      + opts([...new Set(all.map(r => r.type))].filter(Boolean).sort());
    $('#rv-f-run').innerHTML = '<option value="">全部批次</option>'
      + opts([...new Set(all.map(r => r.run))].filter(Boolean).sort().reverse());
    ['rv-f-status', 'rv-f-type', 'rv-f-run'].forEach(id =>
      $('#' + id).addEventListener('change', () => { rvPage = 1; renderReviews(); }));
    $('#rv-f-q').addEventListener('input', () => {
      clearTimeout(renderReviews._t);
      renderReviews._t = setTimeout(() => { rvPage = 1; renderReviews(); }, 200);
    });
    $('#rv-export').addEventListener('click', rvExportConfirmations);
    $('#rv-export-judge').addEventListener('click', rvExportJudge);
    const adjudicator = $('#rv-adjudicator');
    try { adjudicator.value = localStorage.getItem(RV_ADJUDICATOR_KEY) || ''; } catch (e) { /* ignore */ }
    adjudicator.addEventListener('input', () => {
      try { localStorage.setItem(RV_ADJUDICATOR_KEY, adjudicator.value.trim()); } catch (e) { /* ignore */ }
    });
  }
  $('#rv-flow').innerHTML = rvFlowHTML(DB.reviewStats);

  const list = rvSort(rvFiltered());
  const pages = Math.max(1, Math.ceil(list.length / RV_PAGE_SIZE));
  rvPage = Math.min(Math.max(1, rvPage), pages);
  const shown = list.slice((rvPage - 1) * RV_PAGE_SIZE, rvPage * RV_PAGE_SIZE);
  $('#rv-list').innerHTML = shown.map(rvItemHTML).join('') || '<p class="dim">无匹配条目。</p>';
  $('#rv-pager').innerHTML = list.length > RV_PAGE_SIZE
    ? `<button class="rv-pg-btn" data-rvpg="-1"${rvPage <= 1 ? ' disabled' : ''}>‹ 上一页</button>
       <span class="rv-pg-info">第 ${rvPage} / ${pages} 页 · 共 ${list.length} 条</span>
       <button class="rv-pg-btn" data-rvpg="1"${rvPage >= pages ? ' disabled' : ''}>下一页 ›</button>`
    : (list.length ? `<span class="rv-pg-info">共 ${list.length} 条</span>` : '');
  rvJudgeProgress();
}

// 单位详情页折叠区：该单位的审核记录（uid 匹配，默认收起）
function unitReviewsHTML(uid) {
  const list = rvSort((DB.reviews || []).filter(r => r.uid === uid));
  if (!list.length) return '';
  return `<details class="unit-reviews">
    <summary>审核记录 ${list.length} 条<span class="legend-note">争议、AI 复核意见与最终裁决；全库台账见「审核与裁决」页</span></summary>
    <div class="unit-reviews-list">${list.map(rvItemHTML).join('')}</div>
  </details>`;
}

// 裁决卡三态单选暂存 + 分页翻页（事件委托，覆盖 #/reviews 与单位页折叠区）
document.addEventListener('change', e => {
  if (e.target.matches && e.target.matches('input[data-rvdec]')) {
    rvSetDecision(e.target.dataset.rvdec, e.target.value);
  }
  if (e.target.matches && e.target.matches('input[data-rvj]')) {
    const id = e.target.dataset.rvj;
    rvSetJudge(id, { action: e.target.value });
    const box = e.target.closest('.rv-actions');
    if (box) {
      const val = box.querySelector('input[data-rvj-val]');
      const field = val && val.closest('.rv-field');
      const need = (e.target.value === 'both_wrong' || e.target.value === 'custom');
      if (val) {
        val.disabled = !need;
        val.placeholder = e.target.value === 'custom' ? '裁决结论（必填）' : '正确值（必填）';
        if (field) field.classList.toggle('is-disabled', !need);
        if (need) val.focus();
      }
    }
    rvJudgeProgress();
  }
});
document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('input[data-rvj-val]')) {
    rvSetJudge(e.target.dataset.rvjVal, { value: e.target.value });
  }
  if (e.target.matches && e.target.matches('[data-rvj-note]')) {
    rvSetJudge(e.target.dataset.rvjNote, { note: e.target.value });
  }
});
document.addEventListener('click', e => {
  const pg = e.target.closest('[data-rvpg]');
  if (pg && !pg.disabled) { rvPage += Number(pg.dataset.rvpg); renderReviews(); }
});

/* ===================== 工具 ===================== */
function ymToFloat(ym, boundary = 'start') {
  if (!ym) return DB.meta.yearMax + 0.45; // 在任 → 画到坐标轴尽头
  const value = String(ym).trim();
  const range = value.match(/^(\d{4})~(\d{4})$/);
  if (range) {
    const year = Number(range[boundary === 'end' ? 2 : 1]);
    return year + 0.5; // 与生成器一致：年/区间精度按 7 月近似
  }
  const yearOnly = value.match(/^(\d{4})$/);
  if (yearOnly) return Number(yearOnly[1]) + 0.5;
  const month = value.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (month) {
    const monthNo = Number(month[2]);
    if (monthNo >= 1 && monthNo <= 12) {
      return Number(month[1]) + (monthNo - 1) / 12;
    }
  }
  return DB.meta.yearMin; // 非法值由发布闸拦截；前端保持有限坐标
}
function pct(ym, boundary = 'start') {
  const span = DB.meta.yearMax + 0.5 - DB.meta.yearMin;
  return ((ymToFloat(ym, boundary) - DB.meta.yearMin) / span) * 100;
}
function fmt(ym) { return ym ? ym.replace('-', '.') : '至今'; }
// 端点缺失（证据未给出精确年月）显示「？」；只有在任才显示「至今」
// 点观测段（起止皆空、仅某年点佐证）回退到锚点年月 startX/endX，避免显示「？」
function fmtStart(s) { return s.start ? fmt(s.start) : (s.point && s.startX ? fmt(s.startX) : '？'); }
function fmtEnd(s) { return s.exit === 'incumbent' ? '至今' : (s.end ? fmt(s.end) : (s.point && s.endX ? fmt(s.endX) : '？')); }
// 画条几何：缺失端点用脚本提供的 startX/endX 提示值定位
function barStart(s) { return s.start || s.startX; }
function barEnd(s) { return s.exit === 'incumbent' ? null : (s.end || s.endX); }

// 核验三态徽标（2=多源互证 / conflict=分歧待裁决 / human=人工确认 / 其余=单源）
function verifyClass(v) { return v === 'conflict' ? 'verify-conflict' : (v === 2 || v === 'human') ? 'verify-2' : 'verify-1'; }
function verifyText(v) {
  if (v === 2) return '多源 ✓✓';
  if (v === 'human') return '人工 ✓';
  if (v === 'conflict') return '分歧 ⚠';
  return '单源 ✓';
}

// 信源可信度分级（与 data/codebook.md §0.6 一致）
const TIER_INFO = {
  A: '官方原始：批复文件 / 人大任免 / 政府官网 / 工作报告 / 任前公示 / 纪委通报',
  B: '权威二手：央媒、党报、地方年鉴、学术数据集',
  C: '聚合汇编：百科、人物资料库——须 ≥2 独立源互证方可入库',
  D: '低信来源：仅作线索，不支撑结论',
};

// 来源链接 chips（{label,url,tier,title,snap?} 对象数组 → 可点击溯源，按 tier 着色分级；
// snap = website-demo/snapshots/ 下的快照包装页文件名，存在则追加「快照」链接防原页失效）
function srcChipsHTML(arr) {
  if (!arr || !arr.length) return '<span class="src-chip">—</span>';
  return arr.map(x => {
    const tier = String(x.tier || '');
    const tierClass = /^[A-D]$/.test(tier) ? tier : 'x';
    const title = [
      tier ? `${tier} 级 — ${TIER_INFO[tier] || ''}` : '',
      x.title || '',
    ].filter(Boolean).join('\n');
    const label = escHTML(x.label || x.title || x.url || '未命名来源');
    const href = safeExternalHref(x.url);
    const chip = href
      ? `<a class="src-chip tier-${tierClass}" href="${href}" target="_blank" rel="noopener"
          title="${escHTML(title)}"><b class="tier-badge">${escHTML(tier || '?')}</b>${label}</a>`
      : `<span class="src-chip tier-${tierClass}" title="${escHTML(title)}"><b class="tier-badge">${escHTML(tier || '?')}</b>${label}</span>`;
    const snap = x.snap
      ? `<a class="src-chip snap-chip" href="${snapshotHref(x.snap)}" target="_blank" rel="noopener" title="采集当日的正文快照（原页失效仍可查证）">快照</a>`
      : '';
    return chip + snap;
  }).join('');
}

// 端点「N 条证据」展开：到任行露出全部挂接证据；离任行露出离任端子集（ep 含 e 或 claim=离任）
function evItemsHTML(list, spellPerson) {
  return (list || []).map(e => {
    const cross = e.person && spellPerson && e.person !== spellPerson;
    return `<div class="ev-item"><b>${escHTML(e.tier || '?')}</b> ${escHTML(e.label || e.title || e.url || '未命名来源')}${
      e.claim ? ' · ' + escHTML(e.claim) : ''}${e.value ? ' ' + escHTML(e.value) : ''}${
      cross ? ` <span class="cross-person" title="该引文记录的是${escHTML(e.person)}的任免，用作本端点的反推锚点">↻${escHTML(e.person)}</span>` : ''}${
      e.snap ? ` <a class="snap-chip" href="${snapshotHref(e.snap, e.q)}" target="_blank" rel="noopener" title="打开快照并高亮该引文">快照</a>` : ''}${
      e.quote ? `<div class="ev-quote">「${escLines(e.quote)}」</div>` : ''}</div>`;
  }).join('');
}

function evMoreHTML(s) {
  const all = s.allEvidence || [];
  if (!all.length) return '';
  const osid = escHTML(s.osid);
  return `<button class="ev-more" data-ev="${osid}">📑 ${all.length} 条证据</button>
    <div class="ev-all" id="ev-${osid}" hidden>${evItemsHTML(all, s.name)}</div>`;
}

function evMoreEndHTML(s) {
  const ends = (s.allEvidence || []).filter(e => (e.ep || '').includes('e') || e.claim === '离任');
  if (!ends.length) return '';
  const osid = escHTML(s.osid);
  return `<button class="ev-more" data-ev="${osid}-end">📑 ${ends.length} 条证据</button>
    <div class="ev-all" id="ev-${osid}-end" hidden>${evItemsHTML(ends, s.name)}</div>`;
}

// 反推锚点标签：端点无本人直接证据时，简短标签 + 悬停看详情
function reverseAnchorHTML(a, kind) {
  if (!a || !a.person) return '';
  const label = kind === 'end' ? '继任者间接推理' : '前任者间接推理';
  const verb = kind === 'end' ? '反推离任日' : '反推到任日';
  const detail = `据 ${a.person}${a.claim ? '·' + a.claim : ''}${a.value ? ' ' + a.value : ''} ${verb}（本端点无本人直接证据）`;
  return `<span class="anchor-tag" title="${escHTML(detail)}">↻ ${label}</span>`;
}

// 信源分级图例（浏览页表格下方与人物页共用）
function tierLegendHTML() {
  return `<p class="tier-legend">史料来源分级：
    <span class="src-chip tier-A"><b class="tier-badge">A</b>官方原始</span>
    <span class="src-chip tier-B"><b class="tier-badge">B</b>权威二手</span>
    <span class="src-chip tier-C"><b class="tier-badge">C</b>聚合汇编·须互证</span>
    <span class="src-chip tier-D"><b class="tier-badge">D</b>低信·不入库</span>
    <span class="legend-note">悬停查看来源页标题；「·档」= Wayback 存档快照</span>
  </p>`;
}

const tooltip = $('#tooltip');
function showTip(html, x, y) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const pad = 14;
  const r = tooltip.getBoundingClientRect();
  tooltip.style.left = Math.min(x + pad, innerWidth - r.width - 10) + 'px';
  tooltip.style.top = Math.min(y + pad, innerHeight - r.height - 10) + 'px';
}
function hideTip() { tooltip.hidden = true; }

function demoNote() {
  alert('该入口将在正式发布版开放（数据文件目前随仓库 data/ 目录分发）。');
  return false;
}
function copyCite() {
  navigator.clipboard?.writeText($('#cite-text').textContent.trim());
  alert('引用信息已复制。');
}

/* ===================== 首页 · 覆盖透明度（省/市/区县 可折叠树 + 聚合热力） =====================
   分组行（省/市）的逐年值 = 其成员单位逐年覆盖率的均值（真实数据统计，非填补）。
   data.js 不改：聚合与分组完全在此运行时由 uid 关联 DB.counties 完成。 */

// 逐年聚合：成员行该年均值
function aggCells(members, years) {
  const out = new Array(years.length).fill(0);
  for (let i = 0; i < years.length; i++) {
    let sum = 0, n = 0;
    for (const m of members) {
      const v = finiteNumber(m.cov.cells[i], NaN);
      if (Number.isFinite(v)) { sum += v; n++; }
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

// 省 → 地级市 → 单位 三级树。地级市本级(level=prefecture)归入同名市节点；
// 关联不到 DB.counties 的单位入 orphans（渲染为末尾「未归档」节点）。
function buildCoverageTree() {
  const provOrder = DB.provinces.map(p => p.code);
  const ord = k => { const i = provOrder.indexOf(k); return i < 0 ? 99 : i; };
  const tree = [], provIdx = new Map(), prefIdx = new Map(), orphans = [];

  const sink = (provCode, prefName, member) => {
    if (!provIdx.has(provCode)) { const n = { provCode, prefs: [] }; provIdx.set(provCode, n); tree.push(n); }
    const key = provCode + '|' + prefName;
    if (!prefIdx.has(key)) { const s = { name: prefName, members: [] }; prefIdx.set(key, s); provIdx.get(provCode).prefs.push(s); }
    prefIdx.get(key).members.push(member);
  };

  for (const u of DB.coverage.units) {
    const c = byUid[u.uid];
    if (!c) { orphans.push({ cov: u, county: null }); continue; }
    const prefName = c.level === 'prefecture' ? c.name : (c.pref || c.name);
    sink(c.prov, prefName, { cov: u, county: c });
  }

  tree.sort((a, b) => ord(a.provCode) - ord(b.provCode));
  tree.forEach(pn => {
    const provN = provName(pn.provCode);
    // 地级市按官方 GB 码排序（现行市在前、自上而下如省级行；已撤销/历史市无 GB 码 → 沉底）
    const gbKey = name => { const c = DB.prefGbCode && DB.prefGbCode[provN + '|' + name]; return c ? Number(c) : Infinity; };
    pn.prefs.sort((a, b) => gbKey(a.name) - gbKey(b.name) || a.name.localeCompare(b.name, 'zh'));
    pn.prefs.forEach(pf => pf.members.sort((a, b) => {
      const la = a.county && a.county.level === 'prefecture' ? 0 : 1;
      const lb = b.county && b.county.level === 'prefecture' ? 0 : 1;
      const da = a.county && a.county.defunct ? 1 : 0; // 已撤销区县沉底
      const db = b.county && b.county.defunct ? 1 : 0;
      return la - lb || da - db || (a.county ? a.county.name : '').localeCompare(b.county ? b.county.name : '', 'zh');
    }));
  });
  return { tree, orphans };
}

// 市分组行的区县采集进度：已采（现行非撤销区县）/ 现行区县总数。
// 总数取 DB.prefTotals（"省全称|市名"→数，由 gen_pref_county_totals.py 算出、build_demo_data.py 加载）；
// 极少数未登记市回退“done/?”。返回 {done,total,cls}。
function prefCountySeg(provN, pf) {
  const total = finiteNumber(DB.prefTotals && DB.prefTotals[provN + '|' + pf.name], NaN);
  const done = pf.members.filter(m => m.county && m.county.level === 'county' && !m.county.defunct).length;
  if (!Number.isFinite(total) || total <= 0) return { done, total: null, cls: 'pg-none' };
  return { done, total, cls: pgCls(done, total) };
}
// 地级市行“区县 X/Y”字段（独立于热力图色深，色深仍用月度覆盖率）
function prefMeta(provN, pf) {
  const s = prefCountySeg(provN, pf);
  return s.total ? `区县 <b class="${s.cls}">${s.done}/${s.total}</b>` : `区县 <b class="pg-none">${s.done}/?</b>`;
}

function renderHeatmap() {
  const years = DB.coverage.years;
  const hm = $('#heatmap');
  // 首列加宽以容纳「省级名 | 地级市/直辖市 | 区县」三列对齐的进度 meta（见 provLabelHTML）
  const tpl = `24rem repeat(${years.length}, 1fr)`;
  const { tree, orphans } = buildCoverageTree();

  // 省级行三列对齐标签：[省名 定宽][地级市/直辖市 定宽][区县 定宽]——缺项留同宽空位以保上下对齐
  const segCell = x => x
    ? `<span class="hm-pseg"><span class="hm-plab">${escHTML(x.label)}</span><b class="${x.cls}">${
      Math.max(0, Math.trunc(finiteNumber(x.done)))}/${Math.max(0, Math.trunc(finiteNumber(x.total)))}</b></span>`
    : '<span class="hm-pseg is-empty"></span>';
  const provLabelHTML = (code, tri = '') => {
    const s = provSegs(code);
    const segs = s ? segCell(s.pref) + segCell(s.county) : '';
    return `<span class="hm-tw" aria-hidden="true">${escHTML(tri)}</span><span class="hm-pname">${
      escHTML(provName(code))}</span><span class="hm-meta hm-meta3">${segs}</span>`;
  };

  const cellsHTML = (cells, cls) => cells.map((value, i) => {
    const r = clampRatio(value);
    return `<span class="hm-cell ${cls || ''}" data-y="${escHTML(years[i])}" data-r="${Math.round(r * 100)}"
       style="background:rgba(178,58,42,${(0.05 + 0.95 * r).toFixed(3)})"></span>`;
  }).join('');

  // 可展开行（省 / 无市本级的市分组 / 有下辖区县的市本级头）：可点击折叠。
  const expRow = (depth, name, labelHTML, cells, isAgg, cmode = '') =>
    `<button type="button" class="hm-row hm-agg hm-exp${isAgg ? ' is-agg' : ''}" data-name="${escHTML(name)}" data-cmode="${escHTML(cmode)}" aria-expanded="false"
       style="grid-template-columns:${tpl};--depth:${Math.max(0, Math.trunc(finiteNumber(depth)))}">
       <span class="hm-label">${labelHTML}</span>${cellsHTML(cells, 'hm-cell-agg')}</button>`;
  // 可展开子行的行内 meta 标签（地级市分组行：显「区县 b/B」）
  const expLabelHTML = (name, meta, tri = '▸') =>
    `<span class="hm-tw" aria-hidden="true">${escHTML(tri)}</span>${escHTML(name)}${meta ? `<span class="hm-meta">${meta}</span>` : ''}`;

  // 市本级行（无下辖区县时）：不可展开、无三角；色深=月度覆盖率、带「区县 X/Y」字段
  const baseRow = (depth, m, meta, cells) => {
    const u = m.cov, defunct = m.county && m.county.defunct ? '<span class="hm-defunct">已撤销</span>' : '';
    return `<div class="hm-row hm-agg" data-name="${escHTML(u.name)}" style="grid-template-columns:${tpl};--depth:${Math.max(0, Math.trunc(finiteNumber(depth)))}">
      <span class="hm-label"><span class="hm-tw" aria-hidden="true"></span>${escHTML(u.name)}${defunct}${meta ? `<span class="hm-meta">${meta}</span>` : ''}</span>${cellsHTML(cells, 'hm-cell-agg')}</div>`;
  };

  // 叶子行（区县）
  const leafRow = (depth, m) => {
    const u = m.cov, defunct = m.county && m.county.defunct ? '<span class="hm-defunct">已撤销</span>' : '';
    return `<div class="hm-row hm-leaf" data-name="${escHTML(u.name)}" style="grid-template-columns:${tpl};--depth:${Math.max(0, Math.trunc(finiteNumber(depth)))}">
      <span class="hm-label"><span class="hm-tw" aria-hidden="true"></span>${escHTML(u.name)}${defunct}</span>${cellsHTML(u.cells)}</div>`;
  };
  const isPrefBase = m => m.county && m.county.level === 'prefecture'; // 市本级

  const parts = [];
  // 顶部固定年份轴；首列三栏表头结构(三角位+省名+meta3)与省级行完全一致 → 三列上下像素对齐
  parts.push(`<div class="hm-row hm-axis" style="grid-template-columns:${tpl}">` +
    `<span class="hm-axis-head"><span class="hm-tw" aria-hidden="true"></span>` +
    `<span class="hm-pname hm-axis-hd">省级行政区</span>` +
    `<span class="hm-meta hm-meta3"><span class="hm-pseg hm-axis-hd">地级市 / 直辖市</span>` +
    `<span class="hm-pseg hm-axis-hd">区县</span></span></span>` +
    years.map(y => `<span class="hm-year">${finiteNumber(y, NaN) % 5 === 0 ? escHTML("'" + String(y).slice(2)) : ''}</span>`).join('') + '</div>');

  // 列出全部省级行政区（DB.provinces 已按 GB 码排序）：有数据者可展开，无数据者整行置灰、仅显进度。
  const treeByCode = Object.fromEntries(tree.map(pn => [pn.provCode, pn]));
  const emptyCells = new Array(years.length).fill(0);
  DB.provinces.forEach(p => {
    const pn = treeByCode[p.code];
    if (!pn) {
      parts.push(`<div class="hm-row hm-agg is-wip" data-name="${escHTML(provName(p.code))}" style="grid-template-columns:${tpl};--depth:0">` +
        `<span class="hm-label">${provLabelHTML(p.code)}</span>${cellsHTML(emptyCells, 'hm-cell-agg')}</div>`);
      return;
    }
    const isMuni = MUNI_CODES.has(pn.provCode);
    const provN = provName(pn.provCode);
    const members = pn.prefs.flatMap(pf => pf.members);
    const prefsHTML = pn.prefs.map(pf => {
      // 直辖市：辖区/县直接挂在省下（depth 1），不再插一层同名市分组
      if (isMuni) return pf.members.map(m => leafRow(1, m)).join('');
      const base = pf.members.find(isPrefBase);          // 市本级（地级市/县级市本级）
      const counties = pf.members.filter(m => !isPrefBase(m)); // 下辖区县
      // 色深=月度覆盖率（成员单位逐年聚合，非完成度）；「区县 X/Y」为独立字段保留
      const meta = prefMeta(provN, pf);
      const headCells = base ? base.cov.cells : aggCells(counties, years);
      // 仅市本级、无下辖区县：单行，不可展开
      if (!counties.length && base) return baseRow(1, base, meta, base.cov.cells);
      // 有下辖区县：市行作父级；区县收进子目录（depth 2）
      return expRow(1, pf.name, expLabelHTML(pf.name, meta), headCells, !base) +
        `<div class="hm-children" closed>${counties.map(m => leafRow(2, m)).join('')}</div>`;
    }).join('');
    parts.push(
      expRow(0, provN, provLabelHTML(pn.provCode, '▸'), aggCells(members, years), true) +
      `<div class="hm-children" closed>${prefsHTML}</div>`
    );
  });
  if (orphans.length) {
    parts.push(
      expRow(0, '未归档', expLabelHTML('未归档', orphans.length + ' 单位'), aggCells(orphans, years), true) +
      `<div class="hm-children" closed>${orphans.map(m => leafRow(1, m)).join('')}</div>`
    );
  }

  hm.innerHTML = parts.join('');

  // 折叠：点可展开行（省/市），切换其紧邻的 .hm-children
  hm.addEventListener('click', e => {
    const row = e.target.closest('.hm-exp');
    if (!row || !hm.contains(row)) return;
    const next = row.nextElementSibling;
    if (!next || !next.classList.contains('hm-children')) return;
    const open = next.hasAttribute('closed');
    if (open) next.removeAttribute('closed'); else next.setAttribute('closed', '');
    row.setAttribute('aria-expanded', String(open));
    row.querySelector('.hm-tw').textContent = open ? '▾' : '▸';
  });

  // tooltip：统一按 .hm-cell 取数；聚合行=平均覆盖率（聚合），叶子=月度覆盖率
  hm.addEventListener('mousemove', e => {
    const c = e.target.closest('.hm-cell');
    if (!c || !hm.contains(c)) return hideTip();
    const row = c.closest('.hm-row');
    const agg = row.classList.contains('is-agg');
    const label = agg ? '平均覆盖率（聚合）' : '书记+行政正职 任职记录月度覆盖率';
    showTip(`<div class="tt-title">${escHTML(row.dataset.name)} · ${escHTML(c.dataset.y)}</div>
      <div class="tt-sub">${label} ${escHTML(c.dataset.r)}%</div>`,
      e.clientX, e.clientY);
  });
  hm.addEventListener('mouseleave', hideTip);
}

/* ===================== 首页 · 真实统计（由 DB.meta 渲染，避免硬编码漂移） ===================== */
function renderStats() {
  const s = DB.meta.stats;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('#stat-units', s.units);
  set('#stat-spells', s.spells);
  set('#stat-persons', s.persons);
  set('#stat-span', `${DB.meta.yearMin}–${DB.meta.yearMax}`);
  set('#dl-version', DB.meta.version);
  set('#dl-date', DB.meta.released);
  const careerQuality = DB.meta.quality && DB.meta.quality.career;
  if (careerQuality && $('#dl-quality-note')) {
    $('#dl-quality-note').textContent =
      `履历展示层安全呈现 ${careerQuality.publishedRows}/${careerQuality.sourceRows} 条原始行；` +
      `已整组隐藏 ${careerQuality.conflictGroups} 个互斥主键组（${careerQuality.conflictRows} 行）` +
      `，另排除 ${careerQuality.orphanRows} 条人物孤儿。原始 CSV 保持原样供复核。`;
  }
}

/* ===================== 浏览页 ===================== */
// 单位索引与层级辅助（DB.counties 含全部单位，每条带 level：province/prefecture/county）
const byUid = Object.fromEntries(DB.counties.map(c => [c.uid, c]));
const PROV_BY_CODE = Object.fromEntries(DB.provinces.map(p => [p.code, p]));
const provName = code => (PROV_BY_CODE[code] ? PROV_BY_CODE[code].name : code);

// 直辖市：北京 11 / 天津 12 / 上海 31 / 重庆 50（无地级市层，辖区县直接挂省）
const MUNI_CODES = new Set(['11', '12', '31', '50']);
// 完成度着色类
const pgCls = (done, total) => done >= total ? 'pg-full' : (done > 0 ? 'pg-part' : 'pg-none');

// 省级行政区进度分段（省级名是行标签、不计进度）：第二列「地级市/直辖市」+ 第三列「区县」。
// 直辖市无地级市层 → 第二列显示「直辖市 done/1」（done 取本级 prefDone 是否采集）。
function provSegs(code) {
  const p = PROV_BY_CODE[code];
  if (!p || p.prefTotal == null) return null;
  const seg = (label, done, total) => total ? { label, done, total, cls: pgCls(done, total) } : null;
  if (MUNI_CODES.has(code)) {
    const done = p.prefDone > 0 ? 1 : 0;
    return { pref: { label: '直辖市', done, total: 1, cls: pgCls(done, 1) },
      county: seg('区县', p.countyDone, p.countyTotal) };
  }
  return { pref: seg('地级市', p.prefDone, p.prefTotal), county: seg('区县', p.countyDone, p.countyTotal) };
}
// 紧凑字符串（浏览页省卡片 uc-meta 用）：直辖市也带「直辖市 1/1」
function provMeta(code) {
  const s = provSegs(code);
  if (!s) return '';
  const parts = [s.pref, s.county].filter(Boolean).map(x => `${escHTML(x.label)} <b class="${x.cls}">${
    Math.max(0, Math.trunc(finiteNumber(x.done)))}/${Math.max(0, Math.trunc(finiteNumber(x.total)))}</b>`);
  return parts.length ? parts.join(' · ') : '不适用';
}

// 下辖：省→地级市（真实单位；无则按县的 pref 去重生成虚拟市节点）；地级市→其县/区
function realPrefs(prov) { return DB.counties.filter(c => c.level === 'prefecture' && c.prov === prov); }
function virtualPrefs(prov) {
  const names = [...new Set(DB.counties.filter(c => c.level === 'county' && c.prov === prov)
    .map(c => c.pref).filter(Boolean))];
  return names.map(name => ({ virtual: true, level: 'prefecture', prov, name, type: '地级市' }));
}
function prefsOf(prov) {
  const real = realPrefs(prov);
  const realNames = new Set(real.map(p => p.name));
  return real.concat(virtualPrefs(prov).filter(p => !realNames.has(p.name)));
}
function countiesOf(prov, prefName) {
  return DB.counties.filter(c => c.level === 'county' && c.prov === prov && c.pref === prefName);
}

// 定位 loc：{level:'nation'} | {level:'province',prov} | {level:'prefecture',prov,name,uid?} | {level:'unit',uid}
function locFromArg(arg) {
  if (!arg) return { level: 'nation' };
  if (arg.startsWith('prov-')) return { level: 'province', prov: arg.slice(5) };
  if (arg.startsWith('pref-')) {
    const i = arg.indexOf('-', 5);
    if (i < 0) return { level: 'nation' };
    try {
      return { level: 'prefecture', prov: arg.slice(5, i), name: decodeURIComponent(arg.slice(i + 1)) };
    } catch (e) {
      return { level: 'nation' };
    }
  }
  const c = byUid[arg];
  if (!c) return { level: 'nation' };
  if (c.level === 'county') return { level: 'unit', uid: arg };
  return { level: c.level, prov: c.prov, name: c.name, uid: arg }; // 真实省/市单位
}
function prefHash(prov, name) { return '#/browse/pref-' + encodeURIComponent(prov) + '-' + encodeURIComponent(name); }

function renderBreadcrumb(loc) {
  const items = [{ label: '全国', hash: '#/browse' }];
  if (loc.level === 'nation') items[0].current = true;
  else if (loc.level === 'province') items.push({ label: provName(loc.prov), current: true });
  else if (loc.level === 'prefecture') {
    items.push({ label: provName(loc.prov), hash: '#/browse/prov-' + loc.prov });
    items.push({ label: loc.name, current: true });
  } else { // unit
    const c = byUid[loc.uid];
    items.push({ label: provName(c.prov), hash: '#/browse/prov-' + c.prov });
    if (c.pref) items.push({ label: c.pref, hash: prefHash(c.prov, c.pref) });
    items.push({ label: c.name, current: true });
  }
  $('#crumb').innerHTML = items.map(it => it.current
    ? `<b>${escHTML(it.label)}</b>` : `<a data-go="${escHTML(it.hash)}">${escHTML(it.label)}</a>`).join('<span class="sep">›</span>');
}

function coverPct(c) {
  const u = DB.coverage.units.find(x => x.uid === c.uid);
  if (!u || !u.cells.length) return c.hasData ? 0.5 : 0;
  return clampRatio(u.cells[u.cells.length - 1]);
}
function recLabel(c) {
  if (!c.hasData) return '整理中';
  const sp = DB.spells[c.uid];
  const n = sp ? sp.sec.filter(s => !s.gap).length + sp.mayor.filter(s => !s.gap).length : 0;
  return n + ' 任职段';
}
function cardHTML(k) {
  if (k.provNode) {
    const go = '#/browse/prov-' + k.code;
    return `<div class="unit-card" data-go="${escHTML(go)}"><div class="uc-name">${escHTML(k.name)}</div><div class="uc-meta">${provMeta(k.code) || '省级'}</div></div>`;
  }
  if (k.level === 'prefecture') {
    const hash = k.virtual ? prefHash(k.prov, k.name) : '#/browse/' + k.uid;
    return `<div class="unit-card" data-go="${escHTML(hash)}"><div class="uc-name">${escHTML(k.name)}</div>
      <div class="uc-meta">地级市</div><div class="uc-rec">下辖区县</div></div>`;
  }
  return `<div class="unit-card ${k.hasData ? '' : 'is-wip'}" data-go="${escHTML('#/browse/' + k.uid)}">
    <div class="uc-name">${escHTML(k.name)}</div>
    <div class="uc-meta">${escHTML(k.type)}${k.code ? ' · ' + escHTML(k.code) : ''}${k.defunct ? ' · 已撤销' : ''}</div>
    <div class="uc-cov"><i style="width:${Math.round(clampRatio(coverPct(k)) * 100)}%"></i></div>
    <div class="uc-rec">${recLabel(k)}</div></div>`;
}
function renderChildGrid(loc) {
  let kids = [], title = '';
  if (loc.level === 'nation') {
    kids = DB.provinces.map(p => ({ provNode: true, code: p.code, name: p.name }));
    title = '全国 · 省级行政区';
  } else if (loc.level === 'province') {
    kids = prefsOf(loc.prov); title = provName(loc.prov) + ' · 下辖 ' + kids.length + ' 个地级市';
  } else if (loc.level === 'prefecture') {
    kids = countiesOf(loc.prov, loc.name); title = loc.name + ' · 下辖 ' + kids.length + ' 个县/区';
  }
  const box = $('#child-grid');
  if (!kids.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="sect-hd"><span class="badge sub">下辖</span>${escHTML(title)}（点卡片下钻）</div>
    <div class="unit-grid">${kids.map(cardHTML).join('')}</div>`;
}

function renderSearchResults(hits) {
  const box = $('#search-results');
  if (!hits.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = hits.map(c => `<div class="sr-item" data-go="${escHTML('#/browse/' + c.uid)}">
    <span>${escHTML(c.name)}</span><span class="sr-path">${escHTML(provName(c.prov))} · ${escHTML(c.pref || '')}</span></div>`).join('');
}

// 时间轴显示层合并：代理段与紧随其后的同人转正段并为一条（任职记录表仍逐条列出）
function displayLane(spells) {
  const out = [];
  for (const s of spells) {
    const prev = out[out.length - 1];
    // 代理→同人转正：前一段是同一人的代理段、当前段是其转正段 → 并为一条（起点取代理起点）。
    // 判据用结构性的 prev.acting（而非依赖易缺的 exit_type='转正' 即 prev.exit==='formal'），
    // 否则自动采集未标"转正"的代理段无法合并，时间轴出现大量代理/正职双条视觉重叠。
    if (prev && !prev.gap && !s.gap && prev.pid && s.pid &&
        prev.pid === s.pid && prev.acting && !s.acting) {
      out[out.length - 1] = {
        ...s,
        start: prev.start || prev.startX || s.start,
        actingFrom: prev.start,
        actingTo: s.start || null,
      };
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

function laneHTML(spells, title, en, dissolved) {
  const displayed = displayLane(spells);
  const unpositionedPoints = displayed.filter(s => s.point && !barStart(s)).length;
  let bars = displayed.map((s, i) => {
    // 没有合格“在任年点”时间锚的薄记录只在下方任职表展示；时间轴不能伪装到当前年。
    if (s.point && !barStart(s)) return '';
    if (s.gap) {
      const gl = Math.max(pct(s.start, 'start'), 0);
      const gw = Math.max(Math.min(pct(s.end, 'end'), 100) - gl, 1.2);
      // data-tip 会在悬停时重新进入 innerHTML；先转义内容，再转义属性，避免实体被属性解析还原。
      const gapTip = escHTML(s.note);
      return `<div class="tl-bar is-gap" style="left:${gl}%;width:${gw}%"
        data-tip="${escHTML(gapTip)}">缺口 GAP</div>`;
    }
    const rawLeft = pct(barStart(s), 'start');
    const clippedL = rawLeft < 0;                  // 起点早于观察窗 → 钳制到左缘并加 ← 标记
    const left = Math.max(rawLeft, 0);
    const width = Math.max(Math.min(pct(barEnd(s), 'end'), 100) - left, 1.2);
    const narrow = width < 3.4;                    // 窄条不渲染名字（悬停看 tooltip）
    const actingNote = s.actingFrom
      ? `（代理 ${escHTML(fmt(s.actingFrom))} 起${s.actingTo ? '，' + escHTML(fmt(s.actingTo)) + ' 转正' : '，转正时间待查'}）`
      : (s.acting ? '（代理）' : '');
    const exitLabel = EXIT_LABEL[s.exit] || '待查';
    const startLabel = escHTML(fmtStart(s));
    const endLabel = escHTML(fmtEnd(s));
    const tip = s.point
      ? `<b>${escHTML(s.name)}</b> ${startLabel}（${s.currentObservation ? '现任观察' : '在任年点'} · 任期起止不详）`
      : `<b>${escHTML(s.name)}</b> ${startLabel} – ${endLabel}${clippedL ? '（起点早于观察窗）' : ''}<br>
      离任去向：${escHTML(exitLabel)}${s.next && s.next !== '—' ? ' · ' + escHTML(s.next) : ''}${actingNote}`;
    const pid = String(s.pid || '').trim();
    const personAttrs = pid
      ? `data-pid="${escHTML(pid)}" role="button" tabindex="0"`
      : 'data-person-missing="true" title="person_id 缺失，人物档案待建"';
    const ariaLabel = `${s.name}，${s.point ? fmtStart(s) + (s.currentObservation ? ' 现任观察' : ' 在任年点') : fmtStart(s) + '至' + fmtEnd(s)}${
      pid ? '' : '，人物档案待建'}`;
    return `<div class="tl-bar exit-${Object.hasOwn(EXIT_LABEL, s.exit) ? s.exit : 'unknown'}${narrow ? ' is-narrow' : ''}${s.point ? ' is-point' : ''}"
      style="left:${left}%;width:${width}%;animation-delay:${i * 60}ms${pid ? '' : ';cursor:help'}"
      ${personAttrs} data-tip="${escHTML(tip)}"
      aria-label="${escHTML(ariaLabel)}">${clippedL ? '← ' : ''}${escHTML(s.name)}${pid ? '' : '（档案待建）'}</div>`;
  }).join('');

  let grid = '';
  for (let y = DB.meta.yearMin; y <= DB.meta.yearMax; y += 5) {
    grid += `<div class="tl-gridline" style="left:${pct(y + '-01')}%"></div>
             <div class="tl-gridyear" style="left:${pct(y + '-01')}%">${y}</div>`;
  }
  let dis = '';
  if (dissolved) {
    const x = pct(dissolved.ym);
    dis = `<div class="tl-after" style="left:${x}%"></div>
           <div class="tl-dismark" style="left:${x}%"></div>` +
      (dissolved.noLabel ? '' :
        `<div class="tl-dislabel" style="left:${x}%">▼ ${escHTML(fmt(dissolved.ym))} 撤销 · ${escHTML(dissolved.label)}</div>`);
  }
  return `<div class="tl-block">
    <p class="tl-title"><strong>${escHTML(title)}</strong>${escHTML(en)}${
      unpositionedPoints
        ? `<span class="legend-note"> · ${unpositionedPoints} 条无合格时间锚，仅列于任职表</span>`
        : ''
    }</p>
    <div class="tl-wrap">${grid}${dis}${bars}</div>
  </div>`;
}

// 端点核验徽标（多源/单源/无独立来源——只反映独立机构数，不自行判定冲突）
function epStatusHTML(status) {
  if (status === 'multi') return '<span class="mono verify-2">多源 ✓✓</span>';
  if (status === 'single') return '<span class="mono verify-1">单源 ✓</span>';
  return '<span class="mono verify-none">待补</span>';
}

// 每条任职段拆「到任 / 离任」两行：各自时间、事由/去向、独立机构来源、核验
function spellRows(spells, post) {
  return spells.filter(s => !s.gap).map(s => {
    const pid = String(s.pid || '').trim();
    const personHint = '<span class="dim" title="person_id 缺失，暂无人物档案"> · 档案待建</span>';
    const personCell = (content, rowspan = '') => pid
      ? `<td${rowspan} class="td-person" data-pid="${escHTML(pid)}">${content}</td>`
      : `<td${rowspan} style="font-weight:700;cursor:default" title="person_id 缺失，暂无人物档案">${content}${personHint}</td>`;
    // 点观测段：起止不详，仅某时点在任佐证 → 单行呈现，不拆到任/离任
    if (s.point) {
      const when = fmtStart(s);
      const epSrc = (s.anchorSrc && s.anchorSrc.length) ? s.anchorSrc : s.src;
      const epStatus = (epSrc && epSrc.length >= 2) ? 'multi' : (epSrc && epSrc.length ? 'single' : 'none');
      const pointLabel = s.currentObservation ? '现任观察' : '在任年点';
      return `
    <tr class="sp-row sp-arrival">
      <td class="td-post">${escHTML(post)}</td>
      ${personCell(escHTML(s.name))}
      <td class="td-endpoint ep-now">◎ ${pointLabel}</td>
      <td class="mono td-when">${escHTML(when)}</td>
      <td class="td-detail"><span class="exit-tag" style="background:${EXIT_COLOR.point}">起止不详</span><div class="next-line">${s.currentObservation ? '截至该日可确认在任，' : '仅该时点在任佐证，'}到/离任时间待补</div></td>
      <td class="td-src">${srcChipsHTML(epSrc)}</td>
      <td class="td-verify">${epStatusHTML(epStatus)}</td>
      <td class="td-act"><button class="btn-flag" data-flag="${escHTML(`${s.name}|${post}|${when}（${pointLabel}）`)}">报错</button></td>
    </tr>`;
    }
    const incumbent = s.exit === 'incumbent';
    const conflict = s.verify === 'conflict';     // 离任分歧由 merge 阶段权威标注
    const human = s.verify === 'human';
    const flag = `${s.name}|${post}|${fmtStart(s)}–${fmtEnd(s)}`;
    const anchorNote = (s.anchorSrc && s.anchorSrc.length)
      ? `<div class="anchor-note">在任佐证 ${srcChipsHTML(s.anchorSrc)}</div>` : '';

    const arrival = `
    <tr class="sp-row sp-arrival">
      <td rowspan="2" class="td-post">${escHTML(post)}</td>
      ${personCell(`${escHTML(s.name)}${s.acting ? '<span class="acting-tag">代理</span>' : ''}${human ? '<span class="chip-human" title="经人工核定">人工核定</span>' : ''}${s.cSingle ? '<span class="chip-csingle" title="仅有单一 C 级来源（百科/资料库等聚合汇编）支撑，2026-07-05 起按单C级源规则入库，待补权威源复核">单源·C级</span>' : ''}`, ' rowspan="2"')}
      <td class="td-endpoint ep-in">● 到任</td>
      <td class="mono td-when">${escHTML(fmtStart(s))}</td>
      <td class="td-detail"><span class="exit-tag" style="background:${ORIGIN_COLOR[s.originType] || '#9a948a'}">${escHTML(s.origin || '待查')}</span>${s.originPrior ? `<div class="next-line" title="${escHTML(s.originPrior)}">原职：${escHTML(s.originPrior.length > 26 ? s.originPrior.slice(0, 25) + '…' : s.originPrior)}</div>` : ''}</td>
      <td class="td-src">${srcChipsHTML(s.startSrc)}${reverseAnchorHTML(s.startAnchor, 'start')}${anchorNote}${evMoreHTML(s)}</td>
      <td class="td-verify">${epStatusHTML(s.startStatus)}</td>
      <td rowspan="2" class="td-act"><button class="btn-flag" data-flag="${escHTML(flag)}">报错</button></td>
    </tr>`;

    const departure = incumbent ? `
    <tr class="sp-row sp-departure">
      <td class="td-endpoint ep-now">◐ 在任</td>
      <td class="mono td-when">至今</td>
      <td class="td-detail"><span class="exit-tag" style="background:${EXIT_COLOR.incumbent}">在任</span></td>
      <td class="td-src"><span class="dim">现任，暂无离任记录</span></td>
      <td class="td-verify">—</td>
    </tr>` : `
    <tr class="sp-row sp-departure${conflict ? ' is-conflict' : ''}">
      <td class="td-endpoint ep-out">○ 离任</td>
      <td class="mono td-when">${escHTML(fmtEnd(s))}</td>
      <td class="td-detail"><span class="exit-tag" style="background:${EXIT_COLOR[s.exit] || EXIT_COLOR.unknown}">${escHTML(EXIT_LABEL[s.exit] || '待查')}</span>${s.next && s.next !== '—' ? `<div class="next-line">${escHTML(s.next)}</div>` : ''}</td>
      <td class="td-src">${srcChipsHTML(s.endSrc)}${reverseAnchorHTML(s.endAnchor, 'end')}${evMoreEndHTML(s)}</td>
      <td class="td-verify">${conflict ? '<span class="mono verify-conflict" title="多源对离任时间存在分歧，已进入人工审核队列">分歧 ⚠</span>' : epStatusHTML(s.endStatus)}</td>
    </tr>`;

    return arrival + departure;
  }).join('');
}

function renderBrowse() {
  const loc = state.loc || { level: 'nation' };
  renderBreadcrumb(loc);
  renderUnitOfficials(loc);
  renderChildGrid(loc);
}

// 本级两正职面板：county 叶子=主内容；省/市真实单位=本级面板（带「本级」标），其下另有下辖网格
function renderUnitOfficials(loc) {
  const box = $('#level-officials');
  const c = (loc.level === 'unit' || loc.uid) ? byUid[loc.uid] : null;
  if (!c) {
    box.innerHTML = loc.level === 'prefecture'
      ? `<div class="sect-hd"><span class="badge">本级</span>${escHTML(loc.name)} · 本级两正职整理中</div>`
      : '';
    return;
  }
  box.innerHTML = c.hasData ? unitPanelHTML(c, loc.level !== 'unit') : wipPanelHTML(c);
}

function wipPanelHTML(c) {
  return `<div class="county-head"><h2>${escHTML(c.name)}</h2><span class="chip">${escHTML(c.code || '')}</span></div>
    <div class="wip-panel"><div class="seal-block"><span>采集<br>中</span></div>
    <p>该单位数据按计划分批采集中。已上线单位见上方网格，缺口与进度以首页覆盖图为准。</p></div>`;
}

function unitPanelHTML(c, showBadge) {
  const sp = DB.spells[c.uid];
  const t = postTitles(c);
  const dissolved = c.defunct ? { ym: c.defunct, label: c.defunctLabel || '已撤销' } : null;
  const sub = c.level === 'county' ? c.pref : (c.level === 'prefecture' ? provName(c.prov) : '国务院');
  return `
    <div class="county-head">
      <h2>${escHTML(c.name)}</h2>
      ${c.code ? `<span class="chip">${escHTML(c.code)}</span>` : ''}
      <span class="chip">unit_id ${escHTML(c.uid)}</span>
      ${c.defunct ? `<span class="chip chip-defunct">已撤销 ${escHTML(fmt(c.defunct))}</span>` : ''}
    </div>
    <div class="county-meta">
      <span class="chip">${escHTML(c.type)}</span>
      <span class="chip">隶属 ${escHTML(sub)}</span>
      <span class="chip">记录 ${sp.sec.filter(s => !s.gap).length + sp.mayor.filter(s => !s.gap).length} 条</span>
    </div>
    ${c.lineage ? `<div class="lineage">${escLines(c.lineage)}</div>` : ''}
    ${showBadge ? `<div class="sect-hd"><span class="badge">本级</span>${escHTML(c.name)} · 党政两正职</div>` : ''}
    <div class="tl-legend">
      <span><i class="sw sw-promo"></i>晋升</span>
      <span><i class="sw sw-lateral"></i>平调</span>
      <span><i class="sw sw-retire"></i>退二线</span>
      <span><i class="sw sw-purge"></i>落马</span>
      <span><i class="sw sw-incumbent"></i>在任</span>
      <span><i class="sw sw-dismiss"></i>免职/辞职</span>
      <span><i class="sw sw-unknown"></i>去向待查</span>
      <span><i class="sw sw-gap"></i>缺口</span>
      <span class="legend-note">代理期已并入对应任期条（详见下表「代理」行）</span>
    </div>
    ${laneHTML(sp.sec, t.sec, 'PARTY SECRETARY', dissolved)}
    ${laneHTML(sp.mayor, t.mayor, 'MAGISTRATE / MAYOR', dissolved ? { ...dissolved, noLabel: true } : null)}
    <p class="table-note">每条任职段的<strong>到任</strong>与<strong>离任</strong>各自独立取证、分行列出，史料来源与独立机构数（核验）分开呈现。</p>
    <p class="origin-legend">到任来源方向：
      <span class="exit-tag" style="background:var(--seal)">本级提拔</span>
      <span class="exit-tag" style="background:var(--ochre)">外县外区平调</span>
      <span class="exit-tag" style="background:var(--indigo)">上级下派</span>
      <span class="exit-tag" style="background:#7d6754">代理到任</span>
      <span class="exit-tag" style="background:#5b7287">代理转正</span>
      <span class="exit-tag" style="background:#9a948a">来源待查</span>
      <span class="legend-note">由该官员到任前履历推导，分不准者诚实标「来源待查」，不臆断级别</span>
    </p>
    <table class="data-table sp-table">
      <thead><tr><th>职位</th><th>姓名</th><th>任职端点</th><th>时间</th><th>事由 / 去向</th><th>史料来源（独立机构）</th><th>核验</th><th></th></tr></thead>
      <tbody>
        ${spellRows(sp.sec, t.secShort)}
        ${spellRows(sp.mayor, t.mayorShort)}
      </tbody>
    </table>
    ${tierLegendHTML()}
    ${unitReviewsHTML(c.uid)}
    <p class="principle-line">※ 缺口（gap）显式标注——我们宁可展示空白，也不做猜测性填补。每条记录可点击「报错」发起修订。</p>
  `;
}

/* ===================== 人物页 ===================== */
function findRoster(pid) {
  const out = [];
  for (const uid in DB.spells) {
    const c = DB.counties.find(x => x.uid === uid);
    ['sec', 'mayor'].forEach(k => {
      DB.spells[uid][k].forEach(s => {
        if (s.pid === pid) out.push({ ...s, county: c.name, post: k === 'sec' ? '书记' : postTitles(c).mayorShort });
      });
    });
  }
  return out;
}

function metaCell(label, val) {
  const present = val != null && val !== '';
  return `<div class="pm-cell"><dt>${escHTML(label)}</dt>
    <dd class="${present ? '' : 'missing'}">${present ? escHTML(val) : '—（缺失）'}</dd></div>`;
}

function renderPerson(pid) {
  let p = DB.persons[pid];
  const roster = findRoster(pid);
  if (!p) p = thinPerson(pid, roster[0] ? roster[0].name : '未知');

  const careerHTML = p.career ? p.career.map(s => `
    <div class="career-item ${s.county ? 'is-county' : ''}">
      <div class="ci-dates">${escHTML(fmt(s.start))}<br>– ${escHTML(fmt(s.end))}</div>
      <div class="ci-rail"></div>
      <div class="ci-body">
        <div class="ci-pos">${escHTML(s.org)} · ${escHTML(s.pos)}</div>
        ${s.note ? `<div class="ci-org">${escLines(s.note)}</div>` : ''}
        <div class="ci-tags">
          <span class="rank-chip">${escHTML(s.rank)}</span>
          ${s.county ? '<span class="rank-chip" style="border-color:var(--indigo);color:var(--indigo)">县级主政</span>' : ''}
        </div>
        ${s.src && s.src.length ? `<div class="ci-src">${srcChipsHTML(s.src)}</div>` : ''}
      </div>
    </div>`).join('')
    : `<div class="thin-note">⚠ 薄记录（roster-level）：仅有下方任职信息，无完整简历。覆盖率按字段分层如实报告。</div>`;

  const rosterHTML = roster.length ? `
    <h3 style="font-family:var(--serif);margin:1.8rem 0 .6rem">本库任职记录</h3>
    <table class="data-table"><thead>
      <tr><th>单位</th><th>职位</th><th>任期</th><th>离任去向</th><th>核验</th></tr></thead><tbody>
      ${roster.map(r => `<tr>
        <td>${escHTML(r.county)}</td><td>${escHTML(r.post)}${r.acting ? '（代）' : ''}</td>
        <td class="mono">${r.point ? escHTML(fmtStart(r)) + '（年点）' : escHTML(fmtStart(r)) + ' – ' + escHTML(fmtEnd(r))}</td>
        <td><span class="exit-tag" style="background:${EXIT_COLOR[r.exit] || EXIT_COLOR.unknown}">${escHTML(EXIT_LABEL[r.exit] || '待查')}</span></td>
        <td class="mono ${verifyClass(r.verify)}">${verifyText(r.verify)}</td>
      </tr>`).join('')}
    </tbody></table>` : '';

  const purgeHTML = p.purge ? `
    <div class="purge-box">
      <h4>纪律审查与司法记录</h4>
      <dl>
        <div><dt>立案</dt><dd>${escHTML(p.purge.date)} · ${escHTML(p.purge.agency)}</dd></div>
        <div><dt>处分</dt><dd>${escLines(p.purge.discipline)}</dd></div>
        <div><dt>罪名</dt><dd>${escLines(p.purge.charge)}</dd></div>
        <div><dt>判决</dt><dd>${escLines(p.purge.sentence)}</dd></div>
      </dl>
    </div>` : '';

  $('#person-panel').innerHTML = `
    <span class="person-back" onclick="history.back()">← 返回</span>
    <div class="person-head">
      <h2>${escHTML(p.name)}</h2>
      <span class="chip">person_id ${escHTML(pid)}</span>
      <span class="chip">${escHTML(p.status)}</span>
    </div>
    <dl class="person-meta">
      ${metaCell('出生年月', p.birth)}
      ${metaCell('籍贯', p.native)}
      ${metaCell('民族', p.ethnic)}
      ${metaCell('最高学历', p.edu)}
      ${metaCell('入党时间', p.party)}
      ${metaCell('参加工作', p.work)}
    </dl>
    ${purgeHTML}
    <div class="career">
      <h3>履历（career spells）</h3>
      ${careerHTML}
    </div>
    ${rosterHTML}
    <p class="principle-line">※ ${escHTML(p.srcNote || '')}${p.src ? srcChipsHTML(p.src) : ''}　<button class="btn-flag" data-flag="${escHTML(`${p.name}|人物档案|${pid}`)}">报告本页错误</button></p>
    ${p.src && p.src.length ? tierLegendHTML() : ''}
  `;
}

/* ===================== 下载页（DB.files 由生成脚本计算真实行数/大小/MD5） ===================== */
function renderDownload() {
  $('#dl-files').innerHTML = DB.files.map(f => {
    const md5 = String(f.md5 || '');
    const md5Label = /^[0-9a-f]{32}$/.test(md5) ? md5.slice(0, 8) + '…' : md5;
    return `<tr>
      <td class="file-name">${escHTML(f.name)}</td><td>${escHTML(f.desc)}</td>
      <td class="mono">${escHTML(f.rows)}</td><td class="mono">${escHTML(f.size)}</td>
      <td class="mono" title="${escHTML(md5)}">${escHTML(md5Label)}</td>
      <td><span class="fmt-chip" onclick="demoNote()">${escHTML(f.format)}</span></td>
    </tr>`;
  }).join('');
}

/* ===================== 报错弹窗 ===================== */
function openReport(ctx) {
  const [name, where, span] = ctx.split('|');
  $('#report-body').value =
`**记录**: ${where} · ${name}
**任期/标识**: ${span}
**数据版本**: ${DB.meta.version}

**问题描述**: <请填写：哪个字段有误，正确值是什么>

**证据来源**: <URL、文献或年鉴卷期>`;
  $('#modal-report').hidden = false;
}
function closeReport() { $('#modal-report').hidden = true; }
function copyReport() {
  navigator.clipboard?.writeText($('#report-body').value);
  alert('模板已复制。');
}
$('#modal-report').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeReport();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeReport(); });

/* ===================== 事件委托 ===================== */
document.addEventListener('click', e => {
  // 面包屑 / 下辖卡片 / 搜索结果 统一用 data-go 导航
  const go = e.target.closest('[data-go]');
  if (go) {
    const sr = $('#search-results'); if (sr) sr.hidden = true;
    location.hash = go.dataset.go;
    return;
  }
  // 端点「+N 条证据」展开/收起
  const more = e.target.closest('.ev-more');
  if (more) { const el = document.getElementById('ev-' + more.dataset.ev); if (el) el.hidden = !el.hidden; return; }

  const bar = e.target.closest('.tl-bar[data-pid], .td-person[data-pid]');
  if (bar && bar.dataset.pid) { location.hash = `#/person/${bar.dataset.pid}`; return; }

  const flag = e.target.closest('[data-flag]');
  if (flag) { openReport(flag.dataset.flag); return; }
});

document.addEventListener('mousemove', e => {
  const t = e.target.closest('.tl-bar[data-tip]');
  if (t && !t.dataset.pid) { showTip(t.dataset.tip, e.clientX, e.clientY); return; }
  if (t) {
    showTip(`<div class="tt-title">${t.dataset.tip.split('<br>')[0]}</div>
             <div class="tt-sub">${t.dataset.tip.split('<br>')[1] || ''}</div>`, e.clientX, e.clientY);
    return;
  }
  if (!e.target.closest('.hm-cell')) hideTip();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const el = document.activeElement;
    if (el.matches('.tl-bar[data-pid]') && el.dataset.pid) location.hash = `#/person/${el.dataset.pid}`;
    if (el.matches('[data-go]')) location.hash = el.dataset.go;
  }
});

// 全局搜索：按县/区名或 GB 代码直达（拼音待 builder 产出 py 后增强）
$('#unit-search-input').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) return renderSearchResults([]);
  const hits = DB.counties.filter(c => c.level === 'county' &&
    (c.name.toLowerCase().includes(q) || (c.code || '').includes(q))).slice(0, 12);
  renderSearchResults(hits);
});

/* ===================== 启动 ===================== */
renderStats();
renderHeatmap();
renderDownload();
route();
