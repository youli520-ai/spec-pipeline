#!/usr/bin/env node
/**
 * pipeline_ctl.mjs —— 方案流水线（五阶段文件夹状态机）控制器。
 *
 * 定位：**工具，非判据**。它不审查方案内容、不下质量结论，只管三件事：
 *   ① 卡片现在在哪个文件夹；② 该阶段要求的文件齐不齐；③ 可机器核对的
 *      一致性/热点事实（判据行数、同文件改动频率）——只报不拦。
 * 质量判断永远在两个独立上下文的 agent（审核/复核）+ owner 终审那里。
 *
 * ## 流程（五步 + 封顶 + 终态）
 *
 *   00-方案 →(审核)→ 01-下派 →(执行)→ 02-完成 →(复核)→ 03-落地 →(落地+回填)→ 99-归档
 *                          ↑______ 复核不通过：附 recheck.md 驳回意见退回 ______|
 *   · 驳回 2 次封顶 → blocked（等 owner 裁决，不许第 3 次自动回炉）。
 *   · 准入：只有 owner 对话里放行过的方案才能 new 进 00-方案（agent 无权准入）。
 *   · 下派串行：一次只做一个（多会话同工作树互踩是实测过的坑）。
 *   · 落地动作锚你仓库自己的提交纪律（PR review / CI / 部署闸，见 README）。
 *
 * ## 硬闸（拦「跳步」事实，不碰内容）
 *
 *   ① 转移合法性：LEGAL_MOVES 表外的阶段跳转一律拒跑（00→99 直达归档、
 *      99 终态复活等绕过路径全封）；02→01 只能走 ret 别名（保证封顶计数不漏）。
 *   ② ret / 进 03：recheck.md「## 结论」必须已实际填写（防忘填，非内容判断）。
 *   ③ 封顶计数：log 里已有 ≥1 次「ret 复核驳回退回」时第 2 次驳回拒走 ret，
 *      提示 mv <slug> bk 进 blocked（「驳回 2 次封顶」是机制不是口号）。
 *   ④ mv → 01：review.md「## 可行性结论」已填 + spec「准入出处 [必填]」占位符已替换
 *      （防「审核被跳过」——文件存在性检查会被 new 预生成模板恒过，是死路径）。
 *   ⑤ mv → 02：verify.md「## 结论」已填（防「执行自验被跳过」）。
 *   ⑥ land：只能从 03 归档（防 new→land 两步入终态）；[卡:<slug>] 提交标记缺失
 *      只警告不拦（标记是可选约定，硬拦会误伤忘写标记的正常流程）。
 *   ⑦ slug 唯一：全阶段查重（含 99 归档卡——重名卡会永久 mv 卡死）。
 *   ⑧ 阶段缺件警告（只报不拦）。
 *   ⛔ 内容质量不做硬门（「你读过纪律了吗」机器判不了，做硬门只会
 *      造出绕过路径）。②-⑤全是「防忘填/防跳步」的弱启发式。
 *
 * ## 保证层次（为什么这样可以约束 agent）
 *
 *   ① 硬闸（见上，机器拦事实）
 *   ② 规则跟卡走：审核 C0-C6 / 复核 R1-R6 checklist 内嵌在卡片模板里（本脚本生成），
 *      不依赖 agent 读过 README——换机器、换会话都在卡上。
 *   ③ 角色制衡：审核 / 执行 / 复核三个独立上下文（新会话或子代理），同一会话自审 = 走形式。
 *   ④ 事后审计：log.md 流水（时间戳 + 会话指纹）+ 提交台账（你的提交纪律）+ owner 抽查
 *      （status 对 blocked 卡自动摘录驳回意见 + 驳回计数，owner 裁决不用翻文件）。
 *
 * ## 横向病检查（重复造轮子 / 无限叠补丁）
 *
 *   纵向 checklist 管单方案自洽，这两类病是跨轮次的横向病，机器能查的是**事实信号**：
 *   · 重复造轮子 ⇒ spec 模板强制「现有实现盘点」（准入时先搜仓库），审核 C6 把关；
 *     语义重复（改了名的重复实现）grep 抓不到，靠独立上下文带意图搜，降概率不根除。
 *   · 无限叠补丁 ⇒ hot 子命令输出改动频率热点（30 天 ≥3 轮改同一文件 = 嫌疑），
 *     复核 R6 拿它判断「根因修复还是再次特例」，连续特例 ⇒ 升级 owner 裁。
 *   · 在途卡互撞 ⇒ status 解析各在途卡 spec「改动范围」里的反引号路径，两卡重叠警告
 *     （C3「不撞并行线」从纸面 checklist 升级为机器信号；只报不拦）。
 *     阈值是排序提示不是判据——工具输出原始事实，人下结论。
 *
 * ## 资产边界
 *
 *   卡片数据 = owner 的方案过程资产：在 .pipeline/（单人模型建议 gitignore 不入库；
 *   团队场景建议反转——卡片入库共享，见 README 迁移清单）。
 *   机制 = 本脚本 + 内嵌模板：进 git，换机器 clone 即得。
 *   所以模板**必须内嵌在脚本里**（放 _templates/ 目录会在新机器上丢失）。
 *   本脚本即唯一真源；若你另写规范文档，冲突时以脚本为准。
 */
import { execFileSync } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PL = join(ROOT, '.pipeline')

/** 阶段表：key（mv 参数）· 目录名 · 该阶段要求的文件 · 语义 · 下一步指令 */
const STAGES = [
  {
    key: '00', dir: '00-方案', need: ['spec.md'],
    hint: '准入=owner对话放行过；agent 无权放入',
    next: (s) => `补齐 spec [必填] 项（含现有实现盘点）→ 独立会话按 C0-C6 checklist 审核填 review.md → 通过后 mv ${s} 01`,
  },
  {
    key: '01', dir: '01-下派', need: ['spec.md', 'review.md'],
    hint: '独立上下文审核已过；下派串行，一次只做一个',
    next: (s) => `执行（串行：先确认没有别的卡占着 02）→ 填 verify.md（只认数字 + diff 形状自查）→ mv ${s} 02`,
  },
  {
    key: '02', dir: '02-完成', need: ['spec.md', 'review.md', 'verify.md'],
    hint: '执行完；verify 只认数字不认形容词',
    next: (s) => `独立会话按分级复核填 recheck.md（R1-R6，hot 查热点）→ 通过 mv ${s} 03 / 驳回 mv ${s} ret`,
  },
  {
    key: '03', dir: '03-落地', need: ['spec.md', 'review.md', 'verify.md', 'recheck.md'],
    hint: '复核通过待落地；落地走 你的提交纪律（PR/CI/部署闸）',
    next: (s) => `你的提交纪律（PR review / CI / 部署闸） → 回填 docs → mv ${s} land`,
  },
  {
    key: '99', dir: '99-归档', need: ['spec.md', 'review.md', 'verify.md', 'recheck.md'],
    hint: '已落地·文档已回填（终态，冻结；回滚=新卡新 slug）',
    next: () => '终态，不再移动',
  },
  {
    key: 'bk', dir: 'blocked', need: ['spec.md'],
    hint: '驳回 2 次封顶·等owner裁决（status 自动摘录驳回意见）',
    next: (s) => `owner裁决后：放行 → mv ${s} 01；留档 → mv ${s} 99；关闭 → 删卡`,
  },
]

/**
 * 合法转移表（2026-10-31 对抗审查修复 P0-1：此前转移图完全自由，00→99 / 99→01
 * 等跳步路径实测畅通）。from → 允许的 to 列表：
 *   00 → 01        审核通过（owner否决 = 删卡，无 mv）
 *   01 → 00 / 02   00=执行前打回重写 spec；02=执行完成
 *   02 → 03 / 01 / bk   01 只能走 ret 别名（保证封顶计数）；bk=第 2 次驳回封顶
 *   03 → 99        落地完成（land）
 *   99 → （无）     终态冻结；回滚 = 新卡新 slug（slug 全阶段唯一由 new 查重保证）
 *   bk → 01 / 99   01=owner裁决放行（log 指纹留痕，机器不判owner）；99=留档
 */
const LEGAL_MOVES = {
  '00': ['01'],
  '01': ['00', '02'],
  '02': ['03', '01', 'bk'],
  '03': ['99'],
  '99': [],
  'bk': ['01', '99'],
}

/**
 * 「结论已填」弱启发式（2026-10-31 参数化，同款检查挂到 review/verify——P1-2）：
 * 从指定标题往后读，跳过空行与模板说明行（（开头），到下一个 ## 标题止，
 * 剩余正文总长 ≥10 字符才算填了。防「忘了写就移动」的空转，⛔ 不做内容判断。
 * 注：`indexOf('## 结论')` 不会误匹配「## 可行性结论」（子串不连续，已验证）。
 */
function sectionFilled(dir, file, section) {
  const p = join(dir, file)
  if (!existsSync(p)) return `${file} 不存在`
  const text = readFileSync(p, 'utf8')
  const idx = text.indexOf(section)
  if (idx < 0) return `${file} 没有「${section}」一节`
  const lines = text.slice(idx + section.length).split('\n').map((l) => l.trim())
  const real = []
  for (const l of lines) {
    if (!l) continue
    if (l.startsWith('## ')) break
    if (l.startsWith('（') || l.startsWith('(')) continue
    real.push(l)
  }
  if (real.join('').length < 10) return `${file}「${section}」下只有模板预置文字，没有实际填写`
  return null
}

const recheckFilled = (dir) => sectionFilled(dir, 'recheck.md', '## 结论')

/**
 * spec「准入出处 [必填]」占位符检查（P1-2 第三面）：`____` 没被替换 = 准入凭据缺失。
 * 机器不验出处真伪（那要看到owner对话），只防「连出处都没写就往下走」。
 */
function specAdmissionFilled(dir) {
  const p = join(dir, 'spec.md')
  if (!existsSync(p)) return 'spec.md 不存在'
  const text = readFileSync(p, 'utf8')
  const m = text.match(/^- 准入出处 \[必填\]：(.*)$/m)
  if (!m) return 'spec.md 没有「准入出处 [必填]」行'
  const v = (m[1] || '').trim()
  if (!v || v.startsWith('____')) return 'spec「准入出处 [必填]」还是占位符，没有填owner放行出处'
  return null
}

/** log 里「ret 复核驳回退回」出现次数（P1-1 封顶计数的唯一数据源；02→01 只能走 ret 保证它不漏） */
function retCount(dir) {
  try {
    const log = readFileSync(join(dir, 'log.md'), 'utf8')
    return (log.match(/ret 复核驳回退回/g) || []).length
  } catch { return 0 }
}

/** 卡片在当前阶段的停留天数（P2-4 僵尸卡信号：log 最后一行时间戳距今天数） */
function stayDays(dir) {
  try {
    const log = readFileSync(join(dir, 'log.md'), 'utf8')
    const times = [...log.matchAll(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/gm)].map((m) => m[1])
    if (!times.length) return null
    const last = new Date(`${times[times.length - 1].slice(0, 10)}T${times[times.length - 1].slice(11)}`)
    return Math.floor((Date.now() - last.getTime()) / 864e5)
  } catch { return null }
}

/**
 * spec「改动范围」节里反引号包裹的路径（P2-1 在途卡冲突检测的输入）。
 * 约定：路径用 `web/src/...` 写法列出；解析不出就空数组（自由文本写法 ⇒ 不检测，不误报）。
 */
function specDeclaredPaths(dir) {
  try {
    const text = readFileSync(join(dir, 'spec.md'), 'utf8')
    const idx = text.indexOf('## 改动范围')
    if (idx < 0) return []
    let rest = text.slice(idx)
    const end = rest.indexOf('\n## ', 1)
    if (end > 0) rest = rest.slice(0, end)
    return [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((p) => p.includes('/'))
  } catch { return [] }
}

/**
 * 跨工件一致性核对（借鉴 github/spec-kit 的 /speckit.analyze 思路，弱启发式、只报不拦）：
 * 数某一节里的 markdown 表格数据行。返回 null = 该节无表格（自由文本写法）⇒ 无法核对，不报。
 */
function countJudgeRows(text, section) {
  if (text == null) return null
  const idx = text.indexOf(section)
  if (idx < 0) return null
  let rest = text.slice(idx + section.length)
  const end = rest.indexOf('\n## ')
  if (end >= 0) rest = rest.slice(0, end)
  const rows = rest.split('\n').filter((l) => l.trim().startsWith('|'))
  if (rows.length === 0) return null
  return Math.max(0, rows.length - 2) // 减表头 + 分隔行
}

/** 对 02/03/99 的卡做 spec↔verify↔recheck 行数一致性核对，返回警告列表 */
function consistencyWarns(dir) {
  const read = (f) => {
    try { return readFileSync(join(dir, f), 'utf8') } catch { return null }
  }
  const spec = countJudgeRows(read('spec.md'), '## 验收判据')
  const ver = countJudgeRows(read('verify.md'), '## 验证结果')
  const rec = countJudgeRows(read('recheck.md'), '## 判据逐条复核')
  const warns = []
  if (spec != null && ver != null && spec !== ver) {
    warns.push(`spec 判据 ${spec} 条 vs verify 结果 ${ver} 行 —— 对不上（哪边漏了？）`)
  }
  if (ver != null && rec != null && ver !== rec) {
    warns.push(`verify 结果 ${ver} 行 vs recheck 复核 ${rec} 行 —— 对不上`)
  }
  return warns
}

/** mv 别名 → 实际目标 + 附加约束（require 为校验函数，返回 null=通过，字符串=拒绝理由） */
const ALIASES = {
  ret: { to: '01', label: 'ret 复核驳回退回', require: recheckFilled, why: '退回必须附 recheck.md 驳回意见（哪条没过+证据），否则执行 agent 空转' },
  land: { to: '99', label: 'land 落地完成归档', require: null, why: '确认已走完 你的提交纪律（PR/CI/部署闸） 且文档已回填' },
}

const now = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 宿主会话身份（2026-10-31 实测：WorkBuddy 给每个会话注入唯一 ID 与模型 ID）。
 * · SESSION_ID = 宿主分配的会话唯一指纹 —— 同平台多会话的追溯键，自报名字谎报也无妨；
 * · 模型 ID —— 不做身份（同模型多会话重名、中途可换），只做交叉验证参考。
 * log 记短码（前 8 位）防「两个会话都自称执行者」的混淆；非宿主环境显示「无宿主标识」。
 * ⚠️ 诚实边界：agent 理论上可先改环境变量再跑命令伪造 —— 按需修：真出现一次再上宿主侧交叉验证。
 */
function hostIdentity() {
  const sid = process.env.CODEBUDDY_SESSION_ID || process.env.CLAUDE_SESSION_ID || ''
  const model = process.env.CODEBUDDY_CURRENT_MODEL_ID || ''
  const parts = []
  if (sid) parts.push(`会话 ${sid.slice(0, 8)}`)
  if (model) parts.push(model)
  return parts.length ? parts.join(' · ') : '无宿主标识'
}

const stageByKey = (k) => STAGES.find((s) => s.key === k)

/** 全阶段找 slug 对应卡片（不退出版，new 查重用） */
function findCards(slug) {
  const hits = []
  for (const s of STAGES) {
    const p = join(PL, s.dir, slug)
    if (existsSync(p)) hits.push({ stage: s, path: p })
  }
  return hits
}

/** 在全部阶段目录里找 slug 唯一对应的卡片（目录）。找不到/重名都报错。 */
function locateCard(slug) {
  const hits = findCards(slug)
  if (hits.length === 0) return null
  if (hits.length > 1) {
    console.error(`[pipeline] ⛔ slug「${slug}」在多个阶段同时存在（数据被手动动过？）：`)
    for (const h of hits) console.error(`    ${h.stage.dir}`)
    process.exit(1)
  }
  return hits[0]
}

function assertSlug(slug) {
  if (!slug || /[\\/:*?"<>|]/.test(slug) || slug.startsWith('..')) {
    console.error(`[pipeline] ⛔ 非法 slug：「${slug}」（禁 \\ / : * ? " < > | 与 .. 开头）`)
    process.exit(1)
  }
}

/* ============================== git 只读层（hot / report / land 警告用） ============================== */

/** 热点阈值：排序提示，不是判据（工具输出原始事实，人下结论） */
const HOT_DAYS = 30
const HOT_ROUNDS = 3

let seq = 0
const GIT_TMP = join(tmpdir(), 'hermes-pipeline-ctl')
/**
 * git 只读调用的临时落点：系统临时目录（非仓内，防自己出现在 git status）。
 * ⛔ stdio 不能 'pipe' —— 本机沙箱 spawnSync EBUSY；用 fd 重定向再读文件
 * （fd 重定向写法在 Windows 沙箱实测成立）。
 */
function gitOut(args) {
  mkdirSync(GIT_TMP, { recursive: true })
  const f = join(GIT_TMP, `hot.${process.pid}.${++seq}.out`)
  const fd = openSync(f, 'w')
  try {
    execFileSync('git', ['-C', ROOT, ...args], { cwd: ROOT, stdio: ['ignore', fd, 'inherit'] })
  } catch (e) {
    closeSync(fd)
    try { unlinkSync(f) } catch { /* 临时文件删不掉不影响退出码 */ }
    throw e
  }
  closeSync(fd)
  const out = readFileSync(f, 'utf8')
  try { unlinkSync(f) } catch { /* 同上 */ }
  return out
}

/**
 * hot 子命令：改动频率热点（横向病「无限叠补丁」的机器可查事实信号）。
 * 纯 git 只读：git log --follow + --numstat，输出每轮提交的日期/主题/增删行数。
 * 30 天内 ≥3 轮改同一文件 ⇒ 标「叠补丁嫌疑」。判断「根因修复还是特例堆积」由复核 R6 做。
 */
function cmdHot(paths) {
  if (!paths.length) {
    console.error('用法：node scripts/pipeline_ctl.mjs hot <文件路径...>（正斜杠，相对仓库根）')
    process.exit(1)
  }
  const d30 = new Date(Date.now() - HOT_DAYS * 864e5)
  const pad = (n) => String(n).padStart(2, '0')
  const since = `${d30.getFullYear()}-${pad(d30.getMonth() + 1)}-${pad(d30.getDate())}`
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/')
    const out = gitOut(['log', '--follow', '--date=short',
      '--pretty=format:%h%x1f%ad%x1f%s', '--numstat', '--', p])
    const commits = []
    let cur = null
    for (const line of out.split('\n')) {
      if (line.includes('\x1f')) {
        const [sha, date, subject] = line.split('\x1f')
        cur = { sha, date, subject, add: null, del: null }
        commits.push(cur)
      } else if (cur && cur.add === null && /^(-|\d+)\t(-|\d+)\t/.test(line)) {
        const [a, d] = line.split('\t')
        cur.add = a === '-' ? -1 : Number(a)
        cur.del = d === '-' ? -1 : Number(d)
      }
    }
    console.log(`热点报告：${p}`)
    if (commits.length === 0) {
      console.log(`  近 ${HOT_DAYS} 天 0 轮（git log --follow 无记录：新文件、未提交、或路径写错）`)
      continue
    }
    const recent = commits.filter((c) => c.date >= since)
    const suspect = recent.length >= HOT_ROUNDS
    console.log(`  近 ${HOT_DAYS} 天被改 ${recent.length} 轮${suspect ? ` —— ≥${HOT_ROUNDS}，⚠️ 叠补丁嫌疑（阈值是排序提示，不是判据）` : ''}；全历史 ${commits.length} 次：`)
    for (const c of commits.slice(0, 20)) {
      const diff = c.add === null ? '   --   ' : c.add < 0 ? '  二进制  ' : `+${c.add}/-${c.del}`
      console.log(`    ${c.date}  ${c.sha}  ${diff.padEnd(10)}  ${c.subject}`)
    }
    if (commits.length > 20) console.log(`    … 其余 ${commits.length - 20} 次略`)
    console.log('  根因修复还是特例堆积：复核 R6 判断；连续特例 ⇒ 升级owner裁「要不要开根因方案」。')
  }
}

/* ============================== 卡片日报（C-lite 合并桥） ============================== */

/** 功能域：示例域表：按你仓库的提交 scope 体系增删（单事实源在本脚本） */
const CARD_DOMAINS = [
  { key: 'session', label: '会话与聊天' },
  { key: 'group', label: '群聊与渠道' },
  { key: 'ui', label: '前端界面' },
  { key: 'probe', label: '探针与体检' },
  { key: 'review', label: '审查系统' },
  { key: 'deploy', label: '发布与部署' },
  { key: 'docs', label: '规范与文档' },
]

const localDay = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * report 子命令：按「功能域 → 卡片 → 当天提交」出卡片日报。
 * · 功能域 = spec「功能域 [必填]」字段（值域对齐 DOMAINS）；
 * · 提交 = git log -F --grep='[卡:<slug>]'（-F 固定串：方括号不是正则）。
 * 2026-10-31 P2-3：未填功能域与填错分开展示（此前同显「未知域」，误导排查方向）。
 * 无卡片标记的提交不在本视图——用 audit 看当天无卡提交对账。
 */
function cmdReport(day) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error('用法：node scripts/pipeline_ctl.mjs report [YYYY-MM-DD]（缺省=今天）')
    process.exit(1)
  }
  const cards = []
  for (const s of STAGES) {
    let names = []
    try {
      names = readdirSync(join(PL, s.dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch { /* 目录缺失按空 */ }
    for (const slug of names) {
      let domainRaw = null
      try {
        const spec = readFileSync(join(PL, s.dir, slug, 'spec.md'), 'utf8')
        const m = spec.match(/^- 功能域 \[必填\]：\s*([a-z]+)/m)
        if (m) domainRaw = m[1]
      } catch { /* 无 spec 当未填 */ }
      cards.push({ slug, stage: s, domainRaw })
    }
  }
  if (cards.length === 0) {
    console.log(`卡片日报 ${day}：流水线内暂无卡片。`)
    process.exit(0)
  }
  const labelOf = (c) => {
    if (!c.domainRaw) return '其它（功能域 [必填] 未填 —— spec 补上才能挂到功能树）'
    const dom = CARD_DOMAINS.find((d) => d.key === c.domainRaw)
    return dom ? dom.label : `其它（未知域「${c.domainRaw}」，查 spec 拼写）`
  }
  const byDomain = new Map()
  for (const c of cards) {
    const label = labelOf(c)
    if (!byDomain.has(label)) byDomain.set(label, [])
    byDomain.get(label).push(c)
  }
  console.log(`卡片日报 ${day} —— 按功能域\n`)
  for (const [label, list] of byDomain) {
    console.log(`  ${label}`)
    for (const c of list) {
      const out = gitOut(['log', '-F', '--grep', `[卡:${c.slug}]`, '--since', `${day} 00:00`,
        '--pretty=format:%h %s']).split('\n').filter(Boolean)
      console.log(`    · ${c.slug}（${c.stage.dir}）  当天提交 ${out.length} 条`)
      for (const l of out) console.log(`        ${l}`)
      if (out.length === 0) console.log(`        （当天无带 [卡:${c.slug}] 标记的提交）`)
    }
  }
  console.log('\n  无卡片标记的提交不在本视图 —— 无标记提交不在此视图——用 audit 看当天无卡提交对账。')
}

/**
 * audit 子命令（2026-10-31 owner放行「按你的来」）：无卡提交对账 —— 入口纪律的事后可见层。
 * 当天全部提交 vs 带 [卡:<slug>] 标记的提交，差集 = 无卡提交清单。
 * ⚠️ 工具非判据：无卡 ≠ 违规（顺手修/文案/样式/探针本就不走卡）——差集是**抽查线索**，
 * 哪条该走卡没走由owner判；入口判据见接手必读 §1（方案级改动先建卡）。
 */
function cmdAudit(day) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error('用法：node scripts/pipeline_ctl.mjs audit [YYYY-MM-DD]（缺省=今天）')
    process.exit(1)
  }
  const range = ['--since', `${day} 00:00`, '--until', `${day} 23:59:59`]
  const all = gitOut(['log', ...range, '--pretty=format:%h%x1f%s']).split('\n').filter(Boolean)
  // 标记判定只认 subject（第一行）：⛔ 不能用 --grep —— 它连正文一起匹配，
  // 正文里讨论「[卡:slug] 格式」的文档型提交会被误判带卡（实测 9eb0e927 踩中）。
  // （report 匹配完整 [卡:<slug>] 串、误报面小，仍用 --grep，按需修。）
  const markedSet = new Set(
    all.filter((l) => (l.split('\x1f')[1] || '').includes('[卡:')).map((l) => l.split('\x1f')[0]),
  )
  const unmarked = all.filter((l) => !markedSet.has(l.split('\x1f')[0]))
  console.log(`无卡提交对账 ${day} —— 当天提交 ${all.length} 条，带 [卡:] 标记 ${markedSet.size} 条，无卡 ${unmarked.length} 条`)
  if (unmarked.length === 0) {
    console.log(all.length === 0 ? '  （当天无提交）' : '  （全部提交都挂卡 —— 干净）')
    return
  }
  for (const l of unmarked) {
    const [sha, subject] = l.split('\x1f')
    console.log(`    ${sha}  ${subject}`)
  }
  console.log('\n  ⚠️ 无卡 ≠ 违规：顺手修/文案/样式/探针本就不走卡。抽查判读：方案级改动')
  console.log('  （新功能/改行为/动数据链路）出现在上列 = 入口纪律被跳过，追执行会话为什么没建卡。')
}

/* ============================== 卡片模板（内嵌：随脚本走 git） ============================== */

/**
 * 卡片四件套 + log 模板（内嵌：模板必须随脚本走 git，否则换机器丢失）。
 * 2026-10-30 增强：spec 标 [必填]；审核/复核标准以 checklist 内嵌（规则跟卡走）；
 * 复核强度分级写入 recheck 模板。
 * 2026-10-31 增强（横向病）：spec 加「现有实现盘点」（准入先搜仓库）；审核 C6 /
 * 复核 R6；verify 加 diff 形状自查。
 * 2026-10-31 增强（对抗审查修复 P1-4/P2-1/P2-2）：review 放行节带「审核条件清单」；
 * verify 加「审核条件清偿」「与 spec 的偏差」两节（条件验收有主、偏差有正规出口）；
 * spec 改动范围节约定反引号路径写法（status 据此做在途卡冲突检测）。
 */
function templates(slug) {
  const t = (title, body) => `# ${slug} ${title}\n\n${body}`
  return {
    'spec.md': t('方案', [
      '> ⛔ 标 [必填] 的段落空着 = 审核按 checklist 直接驳回。本模板由 pipeline_ctl 生成。',
      '',
      '- 准入出处 [必填]：____（owner对话放行的原话 / 会话出处）',
      '- 日期 [必填]：',
      '- 功能域 [必填]：',
      '  （session=会话与聊天 / group=群聊与渠道 / ui=前端界面 / probe=探针与体检 /',
      '   review=审查系统 / deploy=发布与部署 / docs=规范与文档 / other=其它）',
      '',
      '## 背景与目标 [必填]',
      '',
      '（现状一句话 → 要达成什么）',
      '',
      '## 改动范围 [必填]',
      '',
      '（⛔ owner没明说的一律不动；觉得该动的单列进「请owner裁」。',
      '  涉及路径用反引号包裹列出（示例：web/src/components/X.tsx）—— status 据此做在途卡冲突检测。',
      '  ⚠️ 此处列的才是声明路径；示例文字没带反引号，不会被误收）',
      '',
      '## 现有实现盘点 [必填]',
      '',
      '（用 spec 关键词搜仓库现有实现：`lib/utils.ts`、`web/src` 组件、`_recon/` 探针库。',
      '  已有的写路径；新造的必须写「为什么不能复用」。空着 = 审核 C6 驳回。',
      '  ⚠️ 语义重复（改名的重复实现）grep 抓不到——带着本方案意图搜，别只抄关键词）',
      '',
      '| 已有实现 | 路径 | 复用 / 新造及理由 |',
      '| --- | --- | --- |',
      '',
      '## 验收判据 [必填]',
      '',
      '（每条要可被弄假：验证方式 + 预期数字；⛔ 形容词不算判据）',
      '',
      '| # | 判据 | 验证方式 | 预期 |',
      '| --- | --- | --- | --- |',
      '',
      '## 依赖与串行',
      '',
      '（基于哪个方案 / 落地顺序；无依赖写「无」）',
      '',
      '## 风险与回退 [必填]',
      '',
      '（回退到哪个可用基线、怎么回退）',
      '',
      '## 请owner裁的事项',
      '',
      '（越界候选；无则删本节）',
    ].join('\n')),
    'review.md': t('审核意见（独立上下文审核，非执行会话）', [
      '> 审核 = 技术可行性把关，⛔ 不改方案内容；内容问题写进「发现的问题」请owner裁。',
      '> checklist 逐条过，任何一条 ✗ ⇒ 结论至多「有条件可行」。',
      '',
      '- 审核会话 [必填]：',
      '- 日期 [必填]：',
      '',
      '## 审核 checklist',
      '',
      '- [ ] C0 准入出处已填（owner对话放行的原话/出处）',
      '- [ ] C1 改动范围 = spec 所写，无越界',
      '- [ ] C2 验收判据可测：有验证方式、预期是数字、能被弄假',
      '- [ ] C3 依赖与串行已声明，不撞并行线/在途方案',
      '- [ ] C4 回退路径成立（基线真实存在）',
      '- [ ] C6 现有实现盘点已做：有现成的复用了，或写明不能复用的理由（⛔ 重复造轮子）',
      '',
      '## 可行性结论 [必填·三态]',
      '',
      '（可行 / 有条件可行——列条件 / 不可行——写理由）',
      '',
      '## 发现的问题',
      '',
      '## 放行与条件',
      '',
      '- [ ] 通过 → `mv <slug> 01`',
      '- 审核条件（结论为「有条件可行」时必填；执行者在 verify「审核条件清偿」逐条销账，',
      '  复核核对销账情况——条件没有第二验收人 = 条件白列）：',
      '  1. ____',
      '- [ ] 不通过 → 卡退回 00-方案 补 spec',
    ].join('\n')),
    'verify.md': t('执行自验（执行回执 · ⛔ 只认数字）', [
      '- 执行会话 [必填]：',
      '- 日期 [必填]：',
      '',
      '## 改动文件清单 [必填]',
      '',
      '（与你仓库的提交认领清单一致；spec 外的改动 = 越界，单列说明）',
      '',
      '| 文件 | 改动 |',
      '| --- | --- |',
      '',
      '## 验证结果 [必填·逐条对 spec 判据]',
      '',
      '（结果三态：通过 / 失败 / 不可验证——「不可验证」必须写原因；⛔ 只写「正常/OK」= 没验证）',
      '',
      '| spec 判据 | 探针/命令 | 实测数字 | 结果 |',
      '| --- | --- | --- | --- |',
      '',
      '## 审核条件清偿 [必填]',
      '',
      '（review「放行与条件」列的条件逐条销账：怎么满足的 + 数字；审核结论为「可行」写「无条件」）',
      '',
      '## 与 spec 的偏差',
      '',
      '（执行中发现 spec 写错了什么、实际怎么做的——偏差有正规出口，别静默偏移到复核对不上才发现；无偏差写「无」）',
      '',
      '## diff 形状自查 [必填]',
      '',
      '（横向病自查：只加不减？在既有 wrapper/兼容层上又包一层？特例 if 又加在老地方？',
      '  任一为是 ⇒ 写明这轮为什么是根因修复而不是再叠一层补丁；说不清 ⇒ 退回想清楚再改）',
      '',
      '- 只加不减占比：____',
      '- 叠层/特例嫌疑：____（无 / 有——理由）',
      '',
      '## tsc / 构建 [必填]',
      '',
      '## 版本号',
      '',
      '（读 web/package.json 现值；⛔ 不许凭记忆推算）',
      '',
      '## 结论',
    ].join('\n')),
    'recheck.md': t('复核意见（复核回执 · 独立上下文）', [
      '> 复核强度分级（按改动性质选，跳级要写理由）：',
      '> · **轻复核** = 纯文案/注释/样式：核对 verify 数字 + git diff 与清单一致',
      '> · **重复核** = 行为/数据/链路：关键判据**独立重跑**探针，不信 verify 转述',
      '',
      '- 本次强度 [必填]：____',
      '- 复核会话 [必填]：',
      '- 日期 [必填]：',
      '',
      '## 复核 checklist',
      '',
      '- [ ] R1 spec 判据逐条有复核结果，verify 无「形容词验证」',
      '- [ ] R2 实际 git diff ↔ verify 清单 ↔ 提交认领清单 三方一致（无越界）',
      '- [ ] R3 强度选择符合分级；重复核的贴重跑输出摘要',
      '- [ ] R4（前端改动适用）动过 DOM 层级 ⇒ hover/active/open/focus 四态实测',
      '- [ ] R5「不可验证」的判据都写了原因',
      '- [ ] R6 热点检查：`pipeline_ctl hot` 跑过改动文件；同一文件近 30 天 ≥3 轮被改 ⇒',
      '      标「叠补丁嫌疑」并写明本轮是根因修复还是再次特例（特例 ⇒ 升级owner裁根因方案）',
      '',
      '## 判据逐条复核 [必填]',
      '',
      '| spec 判据 | 复核方式（核对/重跑） | 结果 |',
      '| --- | --- | --- |',
      '',
      '## 结论 [必填]',
      '',
      '（通过 → `mv <slug> 03`；驳回 → 填驳回意见后 `mv <slug> ret`）',
      '',
      '## 驳回意见（⛔ 驳回时必填：哪条判据没过 + 证据；第 2 次驳回将封顶进 blocked）',
    ].join('\n')),
    'log.md': `# ${slug} 流水日志\n\n- ${now()} 创建于 00-方案（准入：owner对话放行）\n`,
  }
}

/* ============================== 命令 ============================== */

function cmdNew(slug) {
  assertSlug(slug)
  // 全阶段查重（P1-3，2026-10-31）：99/bk 里的归档/封顶卡同名会让 locateCard 双命中，
  // 之后整卡 mv 卡死 —— 此前只查 00 目录，实测 99 同名建卡成功后无法移动。
  const existing = findCards(slug)
  if (existing.length > 0) {
    const where = existing.map((h) => h.stage.dir).join('、')
    const kind = existing.some((h) => h.stage.key === '99' || h.stage.key === 'bk')
      ? '归档/封顶卡重名 —— 历史卡占用中，请换 slug（回滚重开=新卡新 slug，不复用旧名）'
      : '在途卡重名 —— 同一方案已有卡在跑，先找到它（status）别开双卡'
    console.error(`[pipeline] ⛔ slug「${slug}」已存在于：${where}。${kind}`)
    process.exit(1)
  }
  const dir = join(PL, '00-方案', slug)
  mkdirSync(dir, { recursive: true })
  const files = templates(slug)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  console.log(`[pipeline] ✅ 建卡 00-方案/${slug}（spec/review/verify/recheck/log）`)
  console.log('    前提回顾：这张卡的准入 = owner已在对话里放行。agent 无权准入。')
  console.log(`    下一步：独立会话按 review.md 的 C0-C6 checklist 审核 → mv ${slug} 01。`)
}

function cmdMv(slug, target, by) {
  assertSlug(slug)
  const hit = locateCard(slug)
  if (!hit) {
    console.error(`[pipeline] ⛔ 找不到卡片「${slug}」。先跑 status 看现有卡。`)
    process.exit(1)
  }
  let alias = null
  if (ALIASES[target]) {
    alias = ALIASES[target]
    target = alias.to
  }
  const toStage = stageByKey(target)
  if (!toStage) {
    console.error(`[pipeline] ⛔ 未知目标「${target}」。可用：${[...STAGES.map((s) => s.key), ...Object.keys(ALIASES)].join(' / ')}`)
    process.exit(1)
  }
  if (hit.stage.key === toStage.key) {
    console.error(`[pipeline] ⛔ 卡片已在 ${toStage.dir}，原地不动。`)
    process.exit(1)
  }
  // 转移合法性（P0-1，2026-10-31 对抗审查修复）：表外跳转一律拒。
  // 此前转移图完全自由：00→99 直达归档、99→01 终态复活等实测畅通（对抗审查 T3/T5/T7）。
  const allowed = LEGAL_MOVES[hit.stage.key] || []
  if (!allowed.includes(toStage.key)) {
    console.error(`[pipeline] ⛔ 非法转移：${hit.stage.dir} → ${toStage.dir}。`)
    console.error(`    本阶段合法去向：${allowed.map((k) => `${stageByKey(k).dir}${k === '01' && hit.stage.key === '02' ? '（只走 ret）' : ''}`).join(' / ') || '无（终态冻结；回滚=新卡新 slug）'}。`)
    if (hit.stage.key === '99') console.error('    99 是终态：落地后发现要回滚 ⇒ new 新卡（新 slug），不复活归档卡。')
    process.exit(1)
  }
  // 02→01 的 ret 专属守卫（独立于 LEGAL 表：'01' 在 allowed 里是给 ret 别名留的通道，
  // 普通 mv 走到这里必须拦——否则封顶计数会漏，回归 R9 实测踩中此坑）。
  if (hit.stage.key === '02' && toStage.key === '01' && !alias) {
    console.error('[pipeline] ⛔ 02→01 的复核驳回必须走 `mv <slug> ret`（ret 强制驳回意见已填，且参与封顶计数）。')
    process.exit(1)
  }
  if (alias) {
    // 封顶计数（P1-1，2026-10-31）：log 已有 ≥1 次 ret ⇒ 本次是第 2 次驳回 ⇒ 拒走 ret，进 blocked。
    // 「驳回 2 次封顶」自此是机制不是口号；此前实测第 3 次 ret 照样放行（对抗审查 T8）。
    if (alias.label === ALIASES.ret.label) {
      const n = retCount(hit.path)
      if (n >= 1) {
        console.error(`[pipeline] ⛔ ${alias.label}被拒：本卡已被驳回 ${n} 次，本次为第 ${n + 1} 次 —— 超封顶（规程：驳回 2 次封顶）。`)
        console.error(`    出路：mv ${slug} bk 进 blocked 等owner裁决（驳回意见已在 recheck.md，status 会自动摘录给owner看）。`)
        process.exit(1)
      }
    }
    if (alias.require) {
      const err = alias.require(hit.path)
      if (err) {
        console.error(`[pipeline] ⛔ ${alias.label}被拒：${err}`)
        console.error(`    原因：${alias.why}`)
        process.exit(1)
      }
    }
    // land 主闸（P0-1）：只能从 03 归档。此前全新空卡 new→land 两步入终态实测畅通（T4/T5）。
    if (alias.to === '99' && hit.stage.key !== '03') {
      console.error(`[pipeline] ⛔ ${alias.label}被拒：land 只能从 03-落地 归档（本卡在 ${hit.stage.dir}）。`)
      console.error('    若是从 blocked 留档 → 用 mv <slug> 99（不带 land 语义）。')
      process.exit(1)
    }
  }
  // 进 03 的硬闸：复核结论没填 = 复核被跳过。防「agent 按规则进行」最关键的一步。
  if (toStage.key === '03') {
    const err = recheckFilled(hit.path)
    if (err) {
      console.error(`[pipeline] ⛔ 进 03-落地被拒：${err}`)
      console.error('    这是防「跳过复核直接落地」的闸；复核结论写进 recheck.md 再移动。')
      process.exit(1)
    }
  }
  // 进 01 的硬闸（P1-2）：审核结论 + 准入出处。防「审核被跳过」——
  // 此前 need 存在性检查被 new 预生成模板恒过（死路径），空 review 实测零警告进 01（T11）。
  if (toStage.key === '01') {
    const errReview = sectionFilled(hit.path, 'review.md', '## 可行性结论')
    if (errReview) {
      console.error(`[pipeline] ⛔ 进 01-下派被拒：${errReview}`)
      console.error('    这是防「跳过审核直接下派」的闸；独立会话按 C0-C6 审核填 review.md 再移动。')
      process.exit(1)
    }
    const errSpec = specAdmissionFilled(hit.path)
    if (errSpec) {
      console.error(`[pipeline] ⛔ 进 01-下派被拒：${errSpec}`)
      process.exit(1)
    }
  }
  // 进 02 的硬闸（P1-2）：执行自验结论。防「执行/自验被跳过」。
  if (toStage.key === '02') {
    const err = sectionFilled(hit.path, 'verify.md', '## 结论')
    if (err) {
      console.error(`[pipeline] ⛔ 进 02-完成被拒：${err}`)
      console.error('    这是防「跳过执行自验」的闸；verify.md 填完实测数字与结论再移动。')
      process.exit(1)
    }
  }
  // 阶段缺件：只警告不拦（阶段语义由人守，工具只报）。
  for (const f of toStage.need) {
    if (!existsSync(join(hit.path, f))) {
      console.error(`[pipeline] ⚠️ 提示：进 ${toStage.dir} 按阶段要求还缺 ${f}（仍允许移动——内容质量由人守，本工具只报）。`)
    }
  }
  const dest = join(PL, toStage.dir, slug)
  renameSync(hit.path, dest)
  // 身份追溯（2026-10-31 owner裁定「可行」）：log 行统一记「别名 · by 谁（可选）· 宿主会话指纹（自动）· 模型（参考）」
  const tags = [alias ? alias.label : null, by ? `by ${by}` : null, hostIdentity()].filter(Boolean)
  const tagStr = `（${tags.join(' · ')}）`
  const line = `- ${now()}  ${hit.stage.dir} → ${toStage.dir}${tagStr}\n`
  const logPath = join(dest, 'log.md')
  let log = ''
  try { log = readFileSync(logPath, 'utf8') } catch { /* log 缺失则重建 */ }
  if (!log) log = `# ${slug} 流水日志\n\n`
  writeFileSync(logPath, log + line, 'utf8')
  console.log(`[pipeline] ✅ ${slug}: ${hit.stage.dir} → ${toStage.dir}${tagStr}`)
  if (toStage.key === '99') {
    console.log('    归档前自问：提交/上线闸走完了吗？文档回填了吗？落地提交 sha 写进 log 了吗？')
    // 提交标记缺失警告（P0-1 配套，只警告不拦：标记是合并桥约定，硬拦会误伤忘写标记的正常流程）
    let marked = ''
    try {
      marked = gitOut(['log', '-F', '--grep', `[卡:${slug}]`, '-1', '--pretty=format:%h']).trim()
    } catch { /* git 失败不阻塞归档 */ }
    if (!marked) {
      console.error(`[pipeline] ⚠️ 无带 [卡:${slug}] 标记的提交 —— report 日报将统计不到本卡。`)
      console.error('    若落地提交忘写标记：下一条提交补上，或确认本卡无需进入卡片视图。')
    }
  }
}

/** 单卡全貌（P2-5，2026-10-31）：owner裁决 blocked 卡 / 抽查时的免翻文件视图 */
function cmdShow(slug) {
  assertSlug(slug)
  const hit = locateCard(slug)
  if (!hit) {
    console.error(`[pipeline] ⛔ 找不到卡片「${slug}」。先跑 status 看现有卡。`)
    process.exit(1)
  }
  const days = stayDays(hit.path)
  const n = retCount(hit.path)
  console.log(`卡「${slug}」 —— ${hit.stage.dir}（${hit.stage.hint}）`)
  console.log(`  停留 ${days ?? '?'} 天${days != null && days >= 7 ? ' ⚠️ ≥7 天，僵尸卡嫌疑' : ''} · 驳回 ${n} 次${n >= 2 ? ' ⚠️ 已封顶' : ''}`)
  const sec = (file, section, max = 3) => {
    try {
      const text = readFileSync(join(hit.path, file), 'utf8')
      const idx = text.indexOf(section)
      if (idx < 0) return
      const lines = text.slice(idx + section.length).split('\n').map((l) => l.trim())
      const real = []
      for (const l of lines) {
        if (real.length && l.startsWith('## ')) break
        if (!l || l.startsWith('（') || l.startsWith('(') || l.startsWith('>')) continue
        real.push(l)
        if (real.length >= max) break
      }
      if (real.length) console.log(`  ${file} ${section}：${real.join(' / ').slice(0, 160)}`)
      else console.log(`  ${file} ${section}：（未填）`)
    } catch { /* 文件缺失跳过 */ }
  }
  sec('spec.md', '## 背景与目标')
  sec('spec.md', '## 改动范围')
  sec('review.md', '## 可行性结论')
  sec('review.md', '## 放行与条件')
  sec('verify.md', '## 结论')
  sec('recheck.md', '## 结论')
  sec('recheck.md', '## 驳回意见', 5)
  try {
    const log = readFileSync(join(hit.path, 'log.md'), 'utf8').trim().split('\n')
    console.log('  log（全部）：')
    for (const l of log.filter(Boolean).slice(-10)) console.log(`    ${l.replace(/^- /, '')}`)
  } catch { /* 无 log */ }
  console.log(`  → 下一步：${hit.stage.next(slug)}`)
}

function cmdStatus() {
  if (!existsSync(PL)) {
    console.error(`[pipeline] ⛔ 流水线目录不存在：${PL}（换机器 clone 后先建六个阶段目录，见 --help）`)
    process.exit(1)
  }
  console.log(`方案流水线 ${PL}\n`)
  const inFlight = [] // P2-1 在途卡冲突检测：00/01/02 的卡 + 声明路径
  for (const s of STAGES) {
    let cards = []
    try {
      cards = readdirSync(join(PL, s.dir), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch { /* 目录不存在按空处理 */ }
    console.log(`  ${s.dir}  ${cards.length} 张  —— ${s.hint}`)
    for (const c of cards) {
      const cardDir = join(PL, s.dir, c)
      const have = s.need.filter((f) => existsSync(join(cardDir, f)))
      const missing = s.need.filter((f) => !existsSync(join(cardDir, f)))
      const extra = ['spec.md', 'review.md', 'verify.md', 'recheck.md'].filter(
        (f) => !s.need.includes(f) && existsSync(join(cardDir, f)),
      )
      const parts = [`· ${c}`]
      parts.push(`[${have.join(', ') || '空卡'}]`)
      const days = stayDays(cardDir)
      if (days != null) parts.push(`⏱️ ${days} 天${days >= 7 ? ' ⚠️' : ''}`)
      if (missing.length) parts.push(`⚠️ 缺: ${missing.join(', ')}`)
      if (extra.length) parts.push(`ℹ️ 多带: ${extra.join(', ')}`)
      console.log(`      ${parts.join('  ')}`)
      // blocked 卡：驳回计数 + 驳回意见摘录（P2-5，owner裁决不用翻文件）
      if (s.key === 'bk') {
        console.log(`        驳回 ${retCount(cardDir)} 次（封顶）。裁决出路：放行 mv ${c} 01 / 留档 mv ${c} 99 / 关闭删卡`)
        try {
          const text = readFileSync(join(cardDir, 'recheck.md'), 'utf8')
          const idx = text.indexOf('## 驳回意见')
          if (idx >= 0) {
            const lines = text.slice(idx).split('\n')
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith('（') && !l.startsWith('## 驳回意见'))
              .slice(0, 3)
            for (const l of lines) console.log(`        摘录：${l.slice(0, 90)}`)
          }
        } catch { /* recheck 缺失跳过 */ }
      }
      // 跨工件一致性（借 spec-kit /analyze；只报不拦）
      if (['02', '03', '99'].includes(s.key)) {
        for (const w of consistencyWarns(cardDir)) console.log(`        ⚠️ ${w}`)
      }
      console.log(`        → 下一步：${s.next(c)}`)
      if (['00', '01', '02'].includes(s.key)) {
        inFlight.push({ slug: c, stage: s.key, paths: specDeclaredPaths(cardDir) })
      }
    }
  }
  // 在途卡冲突检测（P2-1）：两张在途卡的 spec 改动范围声明了同一路径 ⇒ 并行互撞风险。
  // 只报不拦（C3 从纸面 checklist 升级为机器信号）；路径写法不合约定（无反引号）则不检测。
  for (let i = 0; i < inFlight.length; i++) {
    for (let j = i + 1; j < inFlight.length; j++) {
      const a = inFlight[i], b = inFlight[j]
      const overlap = a.paths.filter((p) => b.paths.includes(p))
      if (overlap.length && !(a.stage === b.stage && a.slug === b.slug)) {
        console.log(`  ⚠️ 在途卡互撞：「${a.slug}」与「${b.slug}」的改动范围都声明了 ${overlap.map((p) => `\`${p}\``).join('、')} —— 并行冲突风险，审核 C3 把关`)
      }
    }
  }
  console.log('\n  封顶规则：同一方案被驳回 2 次 → 进 blocked 等owner裁决，不许第 3 次自动回炉（ret 计数机器强制）。')
  console.log('  转移合法性：跳阶段/终态复活一律拒（00→99、99→01 等）；02→01 只能走 ret。')
  console.log('  保证层次：硬闸（本工具）+ checklist 跟卡走 + 审核/执行/复核独立上下文 + log 审计。')
  console.log('  横向病信号：审核 C6（重复造轮子）· 复核 R6 + `hot` 命令（叠补丁热点）· status 在途互撞检测。')
}

function cmdHelp() {
  console.log(`方案流水线（2026-10-30 owner裁定五步 + 封顶 + 终态；2026-10-31 对抗审查修复硬闸）

  00-方案 →(审核)→ 01-下派 →(执行)→ 02-完成 →(复核)→ 03-落地 →(落地+回填)→ 99-归档
                          ↑______ 复核不通过：附 recheck.md 驳回意见退回 ______|

  · 准入：只有owner对话里放行过的方案才能 new 进 00-方案（agent 无权准入）
  · 审核/复核用独立上下文（新会话），同一会话自审 = 走形式
  · verify 只认数字（探针名+断言+数字）；判据要能被弄假
  · 下派串行：一次只做一个；落地走你仓库的提交纪律（PR/CI/部署闸）
  · 驳回 2 次封顶 → blocked（ret 计数机器强制）；99 是终态（冻结，回滚=新卡新 slug）
  · 资产边界：卡片在 .pipeline/（gitignore，owner的资产，不入库不分发）；
    机制 = 本脚本 + 内嵌模板（进 git，换机器 clone 即得）

硬闸（2026-10-31 对抗审查修复后为八道；内容质量仍不做机器硬门）：
  ① 转移合法性：跳阶段/终态复活拒跑（LEGAL_MOVES 表）；02→01 只能走 ret
  ② ret / 进 03：recheck「## 结论」必须已实际填写
  ③ 封顶计数：第 2 次驳回拒走 ret → mv <slug> bk
  ④ 进 01：review「## 可行性结论」已填 + spec「准入出处」占位符已替换
  ⑤ 进 02：verify「## 结论」已填
  ⑥ land：只能从 03；[卡:<slug>] 提交标记缺失只警告（合并桥约定，不硬拦）
  ⑦ slug 全阶段唯一（含 99 归档卡；回滚重开=新卡新 slug）
  ⑧ 阶段缺件警告（只报不拦）

角色制衡 + 事后审计：
  · 审核/执行/复核三个独立上下文；checklist 内嵌卡片模板（规则跟卡走）
  · log 流水（时间戳+会话指纹）+ 提交台账 + owner 抽查
    （status 对 blocked 卡自动摘录驳回意见；show 看单卡全貌）

横向病检查（重复造轮子 / 无限叠补丁 / 在途互撞）：
  · 重复造轮子 ⇒ spec「现有实现盘点」强制准入先搜仓库，审核 C6 把关
    （语义重复 grep 抓不到，独立上下文带意图搜，降概率不根除）
  · 无限叠补丁 ⇒ hot 子命令输出改动频率热点，复核 R6 判断根因修复/再次特例；
    30 天 ≥3 轮 = 嫌疑信号（排序提示，不是判据）
  · 在途卡互撞 ⇒ status 解析在途卡 spec「改动范围」的反引号路径，重叠 ⚠️（只报不拦）
  · verify「diff 形状自查」：只加不减 / 又包一层 wrapper / 特例加在老地方 ⇒ 写清理由

复核强度分级（recheck.md 内置）：
  轻复核 = 纯文案/注释/样式：核对 verify 数字 + diff 一致
  重复核 = 行为/数据/链路：关键判据独立重跑，不信 verify 转述

一致性核对（借 spec-kit /analyze，只报不拦）：
  status 会比对 spec「验收判据」表行数 ↔ verify「验证结果」行数 ↔ recheck 复核行数。

用法：
  node scripts/pipeline_ctl.mjs status            # 存量 + 完整性 + 一致性 + 在途互撞（默认）
  node scripts/pipeline_ctl.mjs new <slug>        # owner放行后在 00-方案 建卡（全阶段查重）
  node scripts/pipeline_ctl.mjs mv <slug> 00|01|02|03|99|bk   # 合法转移移动并记 log
  node scripts/pipeline_ctl.mjs mv <slug> ret     # 复核驳回退回（02→01 唯一通道；硬性要求已填结论）
  node scripts/pipeline_ctl.mjs mv <slug> land    # 落地完成归档（只能从 03；=99）
  node scripts/pipeline_ctl.mjs mv <slug> <目标> --by <名字>   # 可选：操作者署名进 log
  node scripts/pipeline_ctl.mjs show <slug>       # 单卡全貌：结论摘录+驳回计数+停留天数+log
  node scripts/pipeline_ctl.mjs audit [YYYY-MM-DD]  # 无卡提交对账（入口纪律抽查线索）
  node scripts/pipeline_ctl.mjs hot <文件...>     # 改动频率热点（只读 git，横向病信号）
  node scripts/pipeline_ctl.mjs report [YYYY-MM-DD]  # 卡片日报：功能域→卡片→当天提交（合并桥）

身份与追溯（2026-10-31）：
  · mv 的 log 行自动附「会话短码 + 模型」（宿主注入 CODEBUDDY_SESSION_ID / CURRENT_MODEL_ID，
    agent 改不了；同平台多会话靠它追溯，不靠自报名字）
  · --by 是人可读署名层（开会话时owner指定的身份名），可选
  · 下派串行 ⇒ 同一时刻每角色最多一个活跃会话，「时间戳 × 卡名 × 会话短码」唯一确定操作者

合法转移表（表外一律拒）：
  00 → 01（审核过）            01 → 00（打回重写 spec）/ 02（执行完）
  02 → 03（复核过）/ ret（驳回，唯一通道）/ bk（封顶）
  03 → 99（land 落地归档）      bk → 01（owner放行）/ 99（留档）
  99 → 无（终态冻结；回滚 = 新卡新 slug）

阶段要求文件：
${STAGES.map((s) => `  ${s.key}  ${s.dir.padEnd(9)} ${s.need.join(' + ')}`).join('\n')}

（规范版：docs/03-规范/方案流水线操作规程.md；人读速查：.pipeline/README.md；
  三处冲突以本脚本为准。`)
}

function ensureDirs() {
  for (const s of STAGES) mkdirSync(join(PL, s.dir), { recursive: true })
}

/* ============================== 入口 ============================== */

const [, , cmd, ...rest] = process.argv
if (!cmd || cmd === 'status' || cmd === '--help' || cmd === '-h') {
  if (cmd === '--help' || cmd === '-h') { cmdHelp(); process.exit(0) }
  cmdStatus(); process.exit(0)
}
if (cmd === 'new') {
  ensureDirs()
  cmdNew(rest[0]); process.exit(0)
}
if (cmd === 'mv') {
  ensureDirs()
  const args = rest.filter(Boolean)
  const byIdx = args.indexOf('--by')
  const by = byIdx >= 0 && args[byIdx + 1] ? args[byIdx + 1] : null
  const positional = args.filter((a, i) => a !== '--by' && !(byIdx >= 0 && i === byIdx + 1))
  cmdMv(positional[0], positional[1], by); process.exit(0)
}
if (cmd === 'show') {
  const slug = rest.filter(Boolean)[0]
  if (!slug) {
    console.error('用法：node scripts/pipeline_ctl.mjs show <slug>')
    process.exit(1)
  }
  cmdShow(slug); process.exit(0)
}
if (cmd === 'hot') {
  cmdHot(rest.filter(Boolean)); process.exit(0)
}
if (cmd === 'audit') {
  const dayArg = rest.filter(Boolean).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || localDay()
  try {
    cmdAudit(dayArg); process.exit(0)
  } catch (e) {
    console.error('[pipeline] audit 需要在 git 仓库内运行（脚本应位于仓库的 scripts/ 下，由仓库根相对定位）。')
    console.error('  原因：', String(e.message).split('\n')[0])
    process.exit(1)
  }
}
if (cmd === 'report') {
  const dayArg = rest.filter(Boolean).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || localDay()
  cmdReport(dayArg); process.exit(0)
}
console.error(`[pipeline] ⛔ 未知命令「${cmd}」。跑 node scripts/pipeline_ctl.mjs --help 看用法。`)
process.exit(1)
