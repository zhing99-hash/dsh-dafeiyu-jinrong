window.__ModuleLoader__.load({ id: 'dsh-dafeiyu-jinrong', factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports
  const React = require('react')
  const { useCallback, useEffect, useMemo, useRef, useState } = React
  const h = React.createElement
  let clientCtx = null
  const CONFIG_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/config'
  const EVENTS_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/events'
  const MANIFEST_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/manifest'
  const FRAME_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/frame'
  const BALANCE_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/balance'

  const cardStyle = {
    listStyle: 'none', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 12,
    padding: 16, background: 'var(--surface-color, transparent)', display: 'grid', gap: 14,
  }
  const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20 }
  const selectStyle = { minWidth: 120, padding: '6px 10px', borderRadius: 8 }
  const BUBBLE_STATE_OPTIONS = [
    ['IDLE', '空闲'],
    ['THINKING', '思考中'],
    ['WORKING', '工作中'],
    ['WAITING', '等待确认'],
    ['SUCCESS', '完成'],
    ['ERROR', '错误'],
  ]
  const SOUND_STATE_OPTIONS = [
    ['SUCCESS', '对话完成'],
    ['ERROR', '工具出错'],
    ['APPROVAL', '等待审批'],
  ]
  const bubbleGridStyle = {
    display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '6px 14px',
    padding: '10px 12px', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 8,
  }

  function Field({ label, hint, children }) {
    return React.createElement('label', { style: rowStyle },
      React.createElement('span', null,
        React.createElement('span', { style: { display: 'block', fontWeight: 600 } }, label),
        React.createElement('small', { style: { display: 'block', opacity: 0.65, marginTop: 3 } }, hint),
      ),
      children,
    )
  }

  // Watchlist rows are edited locally and written on blur, so typing a price
  // does not issue a settings write per keystroke.
  function WatchlistEditor({ value, disabled, onChange }) {
    const [rows, setRows] = useState(() => (Array.isArray(value) ? value : []))
    const edit = (index, patch) => {
      setRows((previous) => previous.map((row, i) => (i === index ? { ...row, ...patch } : row)))
    }
    const commit = (next) => {
      setRows(next)
      onChange(next)
    }
    return React.createElement('div', { style: { display: 'grid', gap: 8 } },
      rows.length === 0
        ? React.createElement('small', { style: { opacity: 0.65 } }, '还没有自选股。加一个代码就可以看它的情绪和价格提醒。')
        : null,
      ...rows.map((row, index) => React.createElement('div', {
        key: index,
        style: { display: 'grid', gridTemplateColumns: '110px 1fr 90px 90px auto', gap: 6, alignItems: 'center' },
      },
      React.createElement('input', {
        value: row.code ?? '', disabled, placeholder: 'sh600519',
        onChange: (event) => edit(index, { code: event.target.value }),
        onBlur: () => onChange(rows),
      }),
      React.createElement('input', {
        value: row.alias ?? '', disabled, placeholder: '名称（可空）',
        onChange: (event) => edit(index, { alias: event.target.value }),
        onBlur: () => onChange(rows),
      }),
      React.createElement('input', {
        type: 'number', value: row.above ?? '', disabled, placeholder: '高于',
        onChange: (event) => edit(index, { above: Number(event.target.value) }),
        onBlur: () => onChange(rows),
      }),
      React.createElement('input', {
        type: 'number', value: row.below ?? '', disabled, placeholder: '低于',
        onChange: (event) => edit(index, { below: Number(event.target.value) }),
        onBlur: () => onChange(rows),
      }),
      React.createElement('button', {
        type: 'button', disabled,
        onClick: () => commit(rows.filter((_, i) => i !== index)),
      }, '删除'))),
      React.createElement('button', {
        type: 'button', disabled,
        onClick: () => commit([...rows, { code: '', alias: '', above: 0, below: 0 }]),
      }, '添加自选股'),
    )
  }

  function BubbleStatePicker({ value, disabled, onChange, options = BUBBLE_STATE_OPTIONS }) {
    const selected = Array.isArray(value) ? value : []
    const toggle = (state, checked) => {
      const next = new Set(selected)
      if (checked) next.add(state)
      else next.delete(state)
      onChange([...next])
    }
    return React.createElement('div', { style: bubbleGridStyle },
      ...options.map(([state, label]) =>
        React.createElement('label', { key: state, style: { display: 'flex', alignItems: 'center', gap: 4 } },
          React.createElement('input', {
            type: 'checkbox', checked: selected.includes(state), disabled,
            onChange: (event) => toggle(state, event.target.checked),
          }),
          label,
        ),
      ),
    )
  }

  function BalancePanel({ enabled, source }) {
    const [snapshot, setSnapshot] = useState(null)
    const [busy, setBusy] = useState(false)
    const sequence = useRef(0)
    const request = async (force = false) => {
      const current = ++sequence.current
      setBusy(true)
      try {
        const response = await fetch(BALANCE_ENDPOINT, { method: force ? 'POST' : 'GET', cache: 'no-store' })
        if (!response.ok) throw new Error('balance request failed')
        const next = await response.json()
        if (current === sequence.current) setSnapshot(next)
      } catch {
        if (current === sequence.current) setSnapshot((previous) => ({ ...previous, status: 'error', error: '余额查询暂时不可用，请稍后刷新。' }))
      } finally {
        if (current === sequence.current) setBusy(false)
      }
    }
    useEffect(() => {
      setSnapshot(null)
      if (!enabled) return
      void request()
      const timer = setInterval(() => void request(), 60000)
      let stream
      try {
        stream = new EventSource(EVENTS_ENDPOINT)
        stream.onmessage = (event) => {
          try {
            const next = JSON.parse(event.data)
            if (next.kind !== 'balance') return
            sequence.current += 1
            setSnapshot(next)
            setBusy(false)
          } catch {}
        }
      } catch {}
      return () => { clearInterval(timer); stream?.close(); sequence.current += 1 }
    }, [enabled, source])
    if (!enabled) return null
    const money = (row, field) => new Intl.NumberFormat('zh-CN', {
      style: 'currency', currency: row.currency, minimumFractionDigits: 2, maximumFractionDigits: 4,
    }).format(row[field])
    return React.createElement('section', { 'aria-label': 'DeepSeek 余额', 'data-testid': 'dsh-dafeiyu-jinrong-balance', style: { borderTop: '1px solid var(--border-color, #d8d8d8)', paddingTop: 14 } },
      React.createElement('div', { style: rowStyle },
        React.createElement('strong', null, 'DeepSeek 余额'),
        React.createElement('button', { type: 'button', disabled: busy, onClick: () => void request(true) }, busy ? '查询中…' : '刷新余额'),
      ),
      snapshot?.source ? React.createElement('small', null, snapshot.source === 'account' ? '已登录的 DeepSeek 账户' : 'DSH 模型设置中的 API Key') : null,
      snapshot?.balances?.length ? React.createElement('table', { style: { width: '100%', textAlign: 'left', marginTop: 10 } },
        React.createElement('thead', null, React.createElement('tr', null,
          ...['币种', '总余额', '赠送', '充值'].map((label) => React.createElement('th', { key: label, scope: 'col' }, label)),
        )),
        React.createElement('tbody', null, ...snapshot.balances.map((row) => React.createElement('tr', { key: row.currency },
          React.createElement('th', { scope: 'row' }, row.currency),
          ...['total', 'granted', 'toppedUp'].map((field) => React.createElement('td', { key: field }, money(row, field))),
        ))),
      ) : null,
      snapshot?.error ? React.createElement('p', { role: 'status' }, snapshot.error) : null,
      snapshot?.available === false ? React.createElement('p', { role: 'status' }, '账户当前没有可用余额。') : null,
      snapshot?.checkedAt ? React.createElement('small', null,
        `${snapshot.status === 'error' ? '上次成功查询' : '更新时间'}：${new Date(snapshot.checkedAt).toLocaleTimeString()} · 每分钟自动刷新`,
      ) : !snapshot?.error ? React.createElement('p', { role: 'status' }, '正在查询余额…') : null,
    )
  }

  function jumpToBiliWhaleSettings(report) {
    if (typeof document === 'undefined') {
      report('当前页面不支持跳转')
      return
    }
    report('正在打开养鱼设置…')
    const selectSection = (attempt = 0) => {
      const modal = document.querySelector('[data-shortcut-modal="settings"]')
      if (modal) {
        const nav = [...modal.querySelectorAll('button')]
          .find((button) => {
            const text = (button.textContent || '').replace(/\s+/g, '')
            return text === '养鱼' || text.startsWith('养鱼')
          })
        if (nav) {
          nav.click()
          report('已打开 dsh-bili-whale 的养鱼设置')
          return
        }
      }
      if (attempt >= 20) {
        report('没有找到「养鱼」设置，请确认 dsh-bili-whale 已安装并启用')
        return
      }
      setTimeout(() => selectSection(attempt + 1), 50)
    }
    const openSettings = () => {
      if (document.querySelector('[data-shortcut-modal="settings"]')) {
        selectSection()
        return
      }
      const visible = (el) => {
        if (!el || el.closest('.studio-root')) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        return style.visibility !== 'hidden' && style.display !== 'none'
      }
      const direct = [...document.querySelectorAll('button')].find((button) => {
        if (!visible(button)) return false
        const text = (button.getAttribute('aria-label') || button.textContent || '').trim()
        return text === '设置' || text === 'Settings'
      })
      if (direct) {
        direct.click()
        setTimeout(() => selectSection(), 0)
        return
      }
      // The stock panel may replace the sidebar settings launcher, so fall
      // back to the account menu, whose "设置" item always opens the shell.
      const account = [...document.querySelectorAll('button')].find((button) => {
        if (!visible(button)) return false
        const label = (button.getAttribute('aria-label') || '').trim()
        const text = (button.textContent || '').trim()
        return label === '账号菜单' || label === 'Account menu' || /^\d{3}\*{4,}/.test(text)
      })
      if (!account) {
        report('没有找到 DSH 设置入口')
        return
      }
      account.click()
      const findMenu = (attempt = 0) => {
        const menu = [...document.querySelectorAll('button, [role="menuitem"]')].find((el) => {
          if (!visible(el)) return false
          const label = (el.getAttribute('aria-label') || '').trim()
          const text = (el.textContent || '').replace(/\s+/g, '')
          return label === '设置' || label === 'Settings' || text.startsWith('设置')
        })
        if (menu) {
          menu.click()
          setTimeout(() => selectSection(), 0)
          return
        }
        if (attempt >= 20) {
          report('没有找到 DSH 设置入口')
          return
        }
        setTimeout(() => findMenu(attempt + 1), 50)
      }
      setTimeout(() => findMenu(), 0)
    }
    openSettings()
  }

  function CompanionSettings({ embedded = false } = {}) {
    const [status, setStatus] = useState('loading')
    const [value, setValue] = useState({})
    const [busy, setBusy] = useState(false)
    const [jumpMessage, setJumpMessage] = useState('')
    const patchSeq = useRef(0)
    const sliderTimers = useRef(new Map())
    const writable = status === 'ready' && !busy
    const biliWhaleInstalled = (() => {
      try {
        const entries = clientCtx?.slots?.entries?.('settings.section')
        if (!Array.isArray(entries)) return true
        return entries.some((entry) => (entry?.options?.id ?? entry?.id) === 'bili-whale')
      } catch {
        return true
      }
    })()
    useEffect(() => {
      let active = true
      fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`settings request failed: ${response.status}`)
          return response.json()
        })
        .then((next) => { if (active) { setValue(next); setStatus('ready') } })
        .catch(() => { if (active) setStatus('unavailable') })
      return () => {
        active = false
        for (const timer of sliderTimers.current.values()) clearTimeout(timer)
        sliderTimers.current.clear()
      }
    }, [])
    const write = async (field, next) => {
      const seq = ++patchSeq.current
      setBusy(true)
      try {
        const response = await fetch(CONFIG_ENDPOINT, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: next }),
        })
        if (!response.ok) throw new Error(`settings write failed: ${response.status}`)
        const updated = await response.json()
        if (seq === patchSeq.current) {
          setValue(updated)
          setStatus('ready')
        }
      } catch {
        if (seq === patchSeq.current) setStatus('unavailable')
      } finally {
        if (seq === patchSeq.current) setBusy(false)
      }
    }
    const writeSlider = (field, next) => {
      // Keep the slider responsive while dragging: update the local value
      // immediately and send a single debounced PATCH once the user pauses.
      setValue((prev) => ({ ...prev, [field]: next }))
      // Invalidate any in-flight write so a stale response cannot overwrite
      // the optimistic slider value while the user keeps dragging.
      patchSeq.current += 1
      const pending = sliderTimers.current.get(field)
      if (pending) clearTimeout(pending)
      const timer = setTimeout(() => {
        sliderTimers.current.delete(field)
        void write(field, next)
      }, 250)
      sliderTimers.current.set(field, timer)
    }
    return React.createElement(embedded ? 'div' : 'section', {
      className: embedded ? 'studio-settings' : undefined,
      style: embedded ? undefined : cardStyle,
      'data-testid': 'dsh-dafeiyu-jinrong-settings',
    },
      embedded
        ? React.createElement(React.Fragment, null,
            biliWhaleInstalled
              ? React.createElement('div', { className: 'studio-settings-linkcard' },
                  React.createElement('div', null,
                    React.createElement('strong', null, '另一个「养鱼」：dsh-bili-whale'),
                    React.createElement('small', null, 'B站人设、作息、日记和 cookie 设置还在 DSH 设置 → 养鱼；这里放一个快捷入口，避免到处找。'),
                  ),
                  React.createElement('div', { className: 'studio-settings-linkaction' },
                    React.createElement('button', {
                      type: 'button',
                      onClick: () => jumpToBiliWhaleSettings(setJumpMessage),
                    }, '打开养鱼设置'),
                    jumpMessage ? React.createElement('small', null, jumpMessage) : null,
                  ),
                )
              : null,
            React.createElement('div', { className: 'studio-settings-heading' }, '桌面伴侣'),
          )
        : React.createElement('div', null,
            React.createElement('strong', { style: { fontSize: 16 } }, '大肥鱼桌面伴侣'),
            React.createElement('p', { style: { margin: '5px 0 0', opacity: 0.72 } }, '跟随 DSH WebUI 或桌面端启动，在桌面上显示任务状态和余额。'),
          ),
      status === 'unavailable'
        ? React.createElement('span', { role: 'status' }, '大肥鱼设置尚未连接到 DSH Host。')
        : status === 'loading'
        ? React.createElement('span', null, '正在读取设置…')
        : React.createElement(React.Fragment, null,
          React.createElement(Field, { label: '启用大肥鱼', hint: '关闭后立即退出；重新开启无需单独启动程序。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.enabled !== false, disabled: !writable,
              onChange: (event) => void write('enabled', event.target.checked),
            }),
          ),
          React.createElement(Field, { label: '角色大小', hint: `${Math.round((value.scale ?? 1) * 100)}%` },
            React.createElement('input', {
              type: 'range', min: 0.55, max: 1.4, step: 0.05, value: value.scale ?? 1,
              disabled: status !== 'ready',
              onChange: (event) => void writeSlider('scale', Number(event.target.value)),
            }),
          ),
          React.createElement(Field, { label: '活跃程度', hint: '待机动作结束后休息：安静 45～90 秒、标准 25～45 秒、活泼 12～22 秒。' },
            React.createElement('select', {
              value: value.activityLevel ?? 'normal', disabled: !writable, style: selectStyle,
              onChange: (event) => void write('activityLevel', event.target.value),
            },
            React.createElement('option', { value: 'quiet' }, '安静'),
            React.createElement('option', { value: 'normal' }, '标准'),
            React.createElement('option', { value: 'lively' }, '活泼')),
          ),
          React.createElement(Field, { label: '减少动态效果', hint: '减少走动、循环帧和程序化晃动。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.reducedMotion === true, disabled: !writable,
              onChange: (event) => void write('reducedMotion', event.target.checked),
            }),
          ),
          React.createElement(Field, { label: '提示音', hint: '所有提示的总开关（只影响声音）。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.soundEnabled !== false, disabled: !writable,
              onChange: (event) => void write('soundEnabled', event.target.checked),
            }),
          ),
          value.soundEnabled !== false
            ? React.createElement(Field, { label: '提示音与通知场景', hint: '分别选择对话结束、工具出错和等待审批时是否提示。取消勾选后该场景不再播放提示音；macOS 也不再弹出系统通知横幅。Windows / Linux 只播放声音。' },
                React.createElement(BubbleStatePicker, {
                  value: value.soundStates ?? ['SUCCESS', 'ERROR'],
                  options: SOUND_STATE_OPTIONS,
                  disabled: !writable,
                  onChange: (next) => void write('soundStates', next),
                }),
              )
            : null,
          React.createElement(Field, { label: '气泡显示', hint: '常驻显示、完全隐藏，或自定义哪些状态显示气泡。' },
            React.createElement('select', {
              value: value.bubbleMode ?? 'always', disabled: !writable, style: selectStyle,
              onChange: (event) => void write('bubbleMode', event.target.value),
            },
            React.createElement('option', { value: 'always' }, '常驻显示'),
            React.createElement('option', { value: 'hidden' }, '完全隐藏'),
            React.createElement('option', { value: 'custom' }, '自定义显示状态')),
          ),
          (value.bubbleMode ?? 'always') !== 'hidden'
            ? React.createElement(Field, { label: '气泡大小', hint: `${Math.round((value.bubbleScale ?? 1) * 100)}%` },
                React.createElement('input', {
                  type: 'range', min: 0.8, max: 1.2, step: 0.05, value: value.bubbleScale ?? 1,
                  disabled: status !== 'ready',
                  onChange: (event) => void writeSlider('bubbleScale', Number(event.target.value)),
                }),
              )
            : null,
          (value.bubbleMode ?? 'always') === 'custom'
            ? React.createElement(Field, { label: '自定义显示状态', hint: '勾选后，只有这些状态出现时才会显示气泡。' },
                React.createElement(BubbleStatePicker, {
                  value: value.bubbleStates ?? ['SUCCESS', 'ERROR', 'WAITING'],
                  disabled: !writable,
                  onChange: (next) => void write('bubbleStates', next),
                }),
              )
            : null,
          React.createElement(Field, { label: '响应子 Agent', hint: '默认只跟随顶层任务，避免状态过度跳动。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.includeSubagents === true, disabled: !writable,
              onChange: (event) => void write('includeSubagents', event.target.checked),
            }),
          ),
          React.createElement(Field, { label: '页面内桌宠', hint: '在 DSH 页面右下角显示一只跟随状态的小桌宠（纯装饰）；开关后刷新页面生效。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.webOverlay === true, disabled: !writable,
              onChange: (event) => void write('webOverlay', event.target.checked),
            }),
          ),
          React.createElement(Field, { label: '斗图反应', hint: '聊天里出现表情包时，桌宠在自己的气泡里回一张；只读，不会往聊天里发图。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.memeBattle !== false, disabled: !writable,
              onChange: (event) => void write('memeBattle', event.target.checked),
            }),
          ),
          React.createElement('div', { style: { borderTop: '1px solid var(--border-color, #d8d8d8)', paddingTop: 12, display: 'grid', gap: 4 } },
            React.createElement('strong', null, '空闲陪伴'),
            React.createElement('small', { style: { opacity: 0.65 } }, '空闲时显示天气和下一个每日目标倒计时；股票视角不叠加天气。最后 10 秒会优先提醒。'),
          ),
          React.createElement(Field, { label: '显示天气', hint: '按公网 IP 定位城市，天气来自 Open-Meteo；每 30 分钟刷新一次。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.weatherEnabled !== false, disabled: !writable,
              onChange: (event) => void write('weatherEnabled', event.target.checked),
            }),
          ),
          React.createElement(Field, { label: '天气城市覆盖', hint: '留空严格按 IP；代理/VPN 导致城市不准时，填中文城市名，例如“杭州”。' },
            React.createElement('input', {
              defaultValue: value.weatherCity ?? '',
              disabled: !writable,
              placeholder: '留空按 IP',
              style: { minWidth: 220, padding: '6px 10px', borderRadius: 8 },
              onBlur: (event) => void write('weatherCity', event.target.value.trim()),
            }),
          ),
          React.createElement(Field, { label: '天气刷新间隔', hint: `${value.weatherRefreshMinutes ?? 30} 分钟。` },
            React.createElement('input', {
              type: 'range', min: 5, max: 180, step: 5, value: value.weatherRefreshMinutes ?? 30,
              disabled: status !== 'ready',
              onChange: (event) => void writeSlider('weatherRefreshMinutes', Number(event.target.value)),
            }),
          ),
          React.createElement(Field, { label: '每日倒计时目标', hint: '格式：HH:MM 标签，逗号分隔。默认 09:30 开盘、15:30 收盘；可加 17:00 下班。留空关闭倒计时。' },
            React.createElement('input', {
              defaultValue: value.idleTargets ?? '09:30 开盘, 15:30 收盘',
              disabled: !writable,
              placeholder: '09:30 开盘, 15:30 收盘, 17:00 下班',
              style: { minWidth: 280, padding: '6px 10px', borderRadius: 8 },
              onBlur: (event) => void write('idleTargets', event.target.value),
            }),
          ),
          embedded ? null : React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-start' } },
            React.createElement('button', {
              type: 'button',
              onClick: () => { try { clientCtx?.layout?.selectPanel?.('dafeiyu-studio') } catch {} },
            }, '打开大肥鱼工坊（动作 / 气泡 / 斗图）'),
          ),
          React.createElement(Field, { label: '打开 DSH', hint: '自动识别当前客户端；识别不准时可手动选择。' },
            React.createElement('select', { value: value.clientTarget ?? 'auto', disabled: !writable, style: selectStyle,
              onChange: (event) => void write('clientTarget', event.target.value) },
              React.createElement('option', { value: 'auto' }, '自动识别'),
              React.createElement('option', { value: 'web' }, 'WebUI'),
              React.createElement('option', { value: 'desktop' }, '桌面端'),
            ),
          ),
          React.createElement(Field, { label: '显示余额', hint: '气泡显示总余额，下方可查看赠送／充值明细。' },
            React.createElement('input', { type: 'checkbox', checked: value.balanceEnabled !== false, disabled: !writable,
              onChange: (event) => void write('balanceEnabled', event.target.checked) }),
          ),
          React.createElement(Field, { label: '余额来源', hint: '自动模式优先使用 API Key；账户余额和 API Key 余额可能不同。' },
            React.createElement('select', { value: value.balanceSource ?? 'auto', disabled: !writable, style: selectStyle,
              onChange: (event) => void write('balanceSource', event.target.value) },
              React.createElement('option', { value: 'auto' }, '自动'),
              React.createElement('option', { value: 'api-key' }, 'API Key'),
              React.createElement('option', { value: 'account' }, '已登录账户'),
            ),
          ),
          React.createElement('div', { style: { borderTop: '1px solid var(--border-color, #d8d8d8)', paddingTop: 12, display: 'grid', gap: 4 } },
            React.createElement('strong', null, '养鱼'),
            React.createElement('small', { style: { opacity: 0.65 } }, '自选股、价格提醒与情绪市场。点一下鱼再按 Tab，可以在总盘和每只自选股之间切换。只做情绪反馈，不推荐、不建议、不预测。'),
          ),
          React.createElement(Field, { label: '启用行情情绪', hint: '没有 DSH 任务时由行情驱动桌宠；关闭后完全跟随任务状态。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.marketEnabled === true, disabled: !writable,
              onChange: (event) => void write('marketEnabled', event.target.checked),
            }),
          ),
          // These stay visible even when market mode is off. Hiding them behind
          // the switch made the watchlist look missing on a fresh install.
          React.createElement(Field, { label: '情绪市场', hint: '决定桌宠跟随哪个市场；A股额外包含涨跌家数。' },
            React.createElement('select', {
              value: value.marketFocus ?? 'a', disabled: !writable, style: selectStyle,
              onChange: (event) => void write('marketFocus', event.target.value),
            },
            React.createElement('option', { value: 'a' }, 'A股'),
            React.createElement('option', { value: 'hk' }, '港股'),
            React.createElement('option', { value: 'us' }, '美股')),
          ),
          React.createElement(Field, { label: '自选股与价格提醒', hint: '代码示例：sh600519 / 00700 / AAPL。高于或低于填 0 表示不提醒。' },
            React.createElement(WatchlistEditor, {
              value: value.marketWatchlist ?? [],
              disabled: !writable,
              onChange: (next) => void write('marketWatchlist', next),
            }),
          ),
          React.createElement(Field, { label: '轮询间隔', hint: `${value.marketPollSeconds ?? 5} 秒；非交易时段自动降到 60 秒。` },
            React.createElement('input', {
              type: 'range', min: 3, max: 60, step: 1, value: value.marketPollSeconds ?? 5,
              disabled: status !== 'ready',
              onChange: (event) => void writeSlider('marketPollSeconds', Number(event.target.value)),
            }),
          ),
          React.createElement(Field, { label: '提醒冷却', hint: `${Math.round((value.marketAlertCooldown ?? 300) / 60)} 分钟内同一只股票只提醒一次。` },
            React.createElement('input', {
              type: 'range', min: 60, max: 3600, step: 30, value: value.marketAlertCooldown ?? 300,
              disabled: status !== 'ready',
              onChange: (event) => void writeSlider('marketAlertCooldown', Number(event.target.value)),
            }),
          ),
          React.createElement(Field, { label: '任务优先', hint: '有 DSH 任务进行时，先显示任务状态，结束后回到行情情绪。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.marketYieldToTask !== false, disabled: !writable,
              onChange: (event) => void write('marketYieldToTask', event.target.checked),
            }),
          ),
          React.createElement(Field, { label: 'Tushare Token', hint: '可选。填了就能用 Tushare 日线算自选股的量比；填错或过期不影响行情和提醒，只是没有量比。' },
            React.createElement('input', {
              type: 'password',
              defaultValue: value.marketTushareToken ?? '',
              disabled: !writable,
              placeholder: 'tushare.pro 的 token',
              style: { minWidth: 220, padding: '6px 10px', borderRadius: 8 },
              onBlur: (event) => void write('marketTushareToken', event.target.value.trim()),
            }),
          ),
          React.createElement(BalancePanel, { enabled: value.balanceEnabled !== false && value.enabled !== false, source: value.balanceSource ?? 'auto' }),
          busy ? React.createElement('small', { role: 'status' }, '正在保存…') : null,
        ),
    )
  }

  // In-page companion (opt-in via the webOverlay setting). Purely decorative:
  // it mirrors the DSH state as a small looping sprite in the page corner and
  // never blocks or outlives the page. Every failure path ends in "no pet",
  // never in an exception reaching the WebUI.
  function PetOverlay() {
    const [src, setSrc] = useState(null)
    useEffect(() => {
      let alive = true
      let raf = 0
      let source = null
      fetch(MANIFEST_ENDPOINT, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error('manifest'))))
        .then((manifest) => {
          if (!alive) return
          const runtime = { name: '', frames: [], frameMs: 42, loop: true, index: 0, base: 'idle', pulseUntil: 0, reducedMotion: false }
          let preloader = null
          let spent = 0
          const applyClip = (name) => {
            if (runtime.name === name) return
            const clip = manifest.clips[name] || manifest.clips.idle
            runtime.name = name
            runtime.frames = clip.frames
            runtime.frameMs = clip.frameMs || 42
            runtime.loop = clip.loop !== false
            runtime.index = 0
            spent = 0
          }
          const frameUrl = (frame) => FRAME_ENDPOINT + '?frame=' + encodeURIComponent(frame)
          const show = () => {
            if (!alive || runtime.frames.length === 0) return
            setSrc(frameUrl(runtime.frames[runtime.index]))
            if (runtime.frames.length > 1 && typeof Image === 'function') {
              try {
                preloader = preloader || new Image()
                preloader.src = frameUrl(runtime.frames[(runtime.index + 1) % runtime.frames.length])
              } catch {}
            }
          }
          applyClip('idle')
          show()
          if (typeof requestAnimationFrame !== 'function') return
          let previous = 0
          const step = (now) => {
            if (!alive) return
            if (runtime.pulseUntil && Date.now() >= runtime.pulseUntil) {
              runtime.pulseUntil = 0
              applyClip(runtime.base)
              previous = now
              show()
            }
            if (previous && !runtime.reducedMotion) {
              spent += now - previous
              if (spent >= runtime.frameMs) {
                const frames = Math.floor(spent / runtime.frameMs)
                spent %= runtime.frameMs
                runtime.index = runtime.loop
                  ? (runtime.index + frames) % runtime.frames.length
                  : Math.min(runtime.index + frames, runtime.frames.length - 1)
                show()
              }
            }
            previous = now
            raf = requestAnimationFrame(step)
          }
          raf = requestAnimationFrame(step)
          if (typeof EventSource !== 'undefined') {
            try {
              source = new EventSource(EVENTS_ENDPOINT)
              source.onmessage = (event) => {
                try {
                  const message = JSON.parse(event.data)
                  const clipFor = (state, activity) => state === 'WORKING' && manifest.workingActivityMap?.[activity]
                    || manifest.stateMap[state] || 'idle'
                  if (message.kind === 'config') runtime.reducedMotion = message.reducedMotion === true
                  if (message.kind === 'state' && message.state && manifest.stateMap[message.state]) {
                    runtime.base = clipFor(message.state, message.activity)
                    if (message.state !== 'IDLE') runtime.pulseUntil = 0
                    if (!runtime.pulseUntil) applyClip(runtime.base)
                  }
                  if (message.kind === 'task' && message.state === 'WORKING' && message.activity
                    && manifest.workingActivityMap && manifest.workingActivityMap[message.activity]) {
                    runtime.base = clipFor('WORKING', message.activity)
                    if (!runtime.pulseUntil) applyClip(runtime.base)
                  }
                  if (message.kind === 'pulse' && manifest.stateMap[message.state] && message.ttlMs > 0) {
                    runtime.base = clipFor(message.resumeState, message.resumeActivity)
                    const name = clipFor(message.state)
                    const clip = manifest.clips[name]
                    const duration = runtime.reducedMotion ? 0 : clip.frames.length * clip.frameMs
                    const deadline = runtime.name === name ? runtime.pulseUntil : 0
                    runtime.pulseUntil = Math.max(Date.now() + message.ttlMs, deadline || Date.now() + duration)
                    applyClip(name)
                  }
                  show()
                } catch {}
              }
            } catch {}
          }
        })
        .catch(() => {})
      return () => {
        alive = false
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
        try { source?.close() } catch {}
      }
    }, [])
    if (!src) return null
    return React.createElement('img', {
      src, alt: '', 'aria-hidden': true, draggable: false,
      style: {
        position: 'fixed', right: 16, bottom: 12, width: 132, zIndex: 2147483000,
        pointerEvents: 'none', userSelect: 'none', opacity: 0.96,
        filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.25))',
      },
    })
  }

  function registerWebOverlay(ctx) {
    const registerOverlay = () => {
      try {
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-dafeiyu-jinrong-overlay', order: 999 }, () =>
          React.createElement(PetOverlay, {}))
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-dafeiyu-jinrong] failed to register web overlay:', error)
        }
      }
    }
    try {
      ctx.slots.inject('shell.overlay', registerOverlay)
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[dsh-dafeiyu-jinrong] failed to inject overlay slot:', error)
      }
    }
  }

  // ===== 大肥鱼工坊（0.4） =====
  // A full-page editor in the left-column panel list. The host owns the spec
  // and renders the exact preview with the Qt BubbleRenderer, so this page is
  // a form editor plus a truth-from-the-pet preview, not a second renderer.
  const STUDIO_API = '/plugins/dsh-dafeiyu-jinrong'
  const STUDIO_MODULE_TYPES = [
    ['text', '文本'], ['icon', '图标'], ['image', '图片'],
    ['tasks', '任务'], ['quote', '股票一行'], ['indices', '大盘指数'], ['divider', '分割线'], ['spacer', '留白'],
  ]
  const STUDIO_TEXT_FIELDS = [
    ['message', '主文案'], ['detail', '副文案'], ['idleMeta', '天气 / 倒计时'], ['balance', '余额'],
    ['randomLine', '随机台词'], ['caption', '图片说明'], ['taskTitle', '任务标题'],
    ['state', '状态'], ['text', '固定文字'],
  ]
  const STUDIO_CLICK_REGIONS = [['head', '头部'], ['body', '身体'], ['tail', '尾巴'], ['double', '双击']]
  const STUDIO_PREVIEW_DATA = {
    state: 'WORKING',
    message: '正在处理任务呢',
    detail: 'DSH · 大肥鱼陪你看着',
    idleMeta: '杭州：多云 26°C · 开盘倒计时 02:15:30',
    quote: { name: '中科曙光', price: 78.3, pct: -0.38, volumeRatio: 0.99, limit: { kind: 'above', value: 80 } },
    indices: [{ name: '上证', pct: -0.6 }, { name: '深证', pct: 0.8 }, { name: '创指', pct: 2.0 }],
    taskTitle: '3 个任务进行中',
    tasks: [
      { state: 'WORKING', project: 'zhuochong', task: '编辑 bubble.py' },
      { state: 'THINKING', project: 'zhuochong' },
      { state: 'WAITING', task: '等待确认' },
    ],
    balance: '账户余额 ¥12.34',
    randomLine: '戳我干嘛，任务还在跑呢',
    labels: { IDLE: '空闲', THINKING: '思考中', WORKING: '工作中', WAITING: '等待确认', SUCCESS: '完成', ERROR: '错误' },
  }
  const STUDIO_STATES = ['IDLE', 'THINKING', 'WORKING', 'WAITING', 'SUCCESS', 'ERROR', 'MULTI_TASK', 'BALANCE']
  const STUDIO_CSS = `
.studio-root{height:100%;min-height:0;overflow:auto;padding:22px 26px 40px;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.studio-root *{box-sizing:border-box}
.studio-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.studio-head h1{font-size:18px;margin:0;font-weight:650}
.studio-sub{display:block;margin-top:3px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.studio-tabs{display:flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.studio-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer}
.studio-tab.is-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.studio-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.studio-msg{font-size:11px;color:var(--dsw-alias-label-secondary)}
.studio-columns{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
@media (max-width: 1000px){.studio-columns{grid-template-columns:1fr}}
.studio-stack{display:grid;gap:12px;min-width:0}
.studio-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px;display:grid;gap:12px;min-width:0}
.studio-card-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:650}
.studio-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}
.studio-field{display:grid;gap:4px;min-width:0}
.studio-field>span{font-size:11px;color:var(--dsw-alias-label-secondary)}
.studio-input,.studio-select,.studio-textarea{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:6px 8px;font-size:12px;min-width:0;width:100%}
.studio-textarea{min-height:58px;resize:vertical;font-family:inherit}
.studio-btn{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);padding:5px 10px;font-size:12px;cursor:pointer}
.studio-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.studio-btn.primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}
.studio-btn.danger{color:var(--dsw-alias-state-error-primary)}
.studio-btn:disabled{opacity:.5;cursor:default}
.studio-btn.small{padding:2px 6px;font-size:11px}
.studio-presets{display:flex;gap:6px;flex-wrap:wrap}
.studio-row{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px;display:grid;gap:8px;background:var(--dsw-alias-bg-base)}
.studio-row-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.studio-row-title{font-size:11px;color:var(--dsw-alias-label-secondary)}
.studio-modules{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}
.studio-module{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:8px;display:grid;gap:6px;min-width:150px;flex:1 1 180px}
.studio-module-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.studio-module-head .studio-select{width:auto;min-width:82px}
.studio-inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.studio-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.studio-color{display:inline-flex;align-items:center;gap:4px;min-width:0}
.studio-color input[type=color]{width:28px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent}
.studio-color .studio-input{width:96px}
.studio-preview{position:sticky;top:0;display:grid;gap:8px}
.studio-preview-box{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px;display:flex;justify-content:center;min-height:160px;align-items:center}
.studio-preview-box img{max-width:100%;height:auto;display:block}
.studio-empty{padding:40px;text-align:center;color:var(--dsw-alias-label-secondary)}
.studio-meme-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.studio-meme{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:6px;display:grid;gap:5px;background:var(--dsw-alias-bg-base)}
.studio-meme img{width:100%;height:96px;object-fit:contain;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.studio-meme small{font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.studio-divider{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}
.studio-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.studio-json{width:100%;min-height:120px;font-family:ui-monospace,Consolas,monospace;font-size:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:8px}
.studio-settings{max-width:900px;display:grid;gap:2px}
.studio-settings-linkcard{display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;margin:2px 0 10px}
.studio-settings-linkcard strong{display:block;font-size:14px}
.studio-settings-linkcard small{display:block;margin-top:3px;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.studio-settings-linkaction{display:flex;align-items:flex-end;flex-direction:column;gap:5px;flex:none}
.studio-settings-linkaction button{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:7px 12px;font:inherit;cursor:pointer;white-space:nowrap}
.studio-settings-linkaction button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.studio-settings-heading{font-size:16px;font-weight:650;margin:2px 0 6px}
.analysis-root{display:grid;gap:12px;max-width:1120px}
.analysis-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:11px 14px}
.analysis-status{display:flex;align-items:center;gap:8px;min-width:0}
.analysis-status small{color:var(--dsw-alias-label-tertiary);font-size:11px}
.analysis-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-label-tertiary) 15%,transparent)}
.analysis-dot.online{background:#12B85A;box-shadow:0 0 0 3px rgba(18,184,90,.16)}
.analysis-error{color:#E5484D!important}
.analysis-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.analysis-actions small{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-right:4px}
.analysis-subnav{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:7px}
.analysis-subtab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 10px;border-radius:7px;font:inherit;cursor:pointer}
.analysis-subtab.is-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.analysis-notice{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.analysis-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}
.analysis-empty strong{display:block;color:var(--dsw-alias-label-primary);font-size:14px;margin-bottom:4px}
.analysis-empty p{margin:0 0 8px}
.analysis-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.analysis-inline .studio-input{max-width:330px}
.analysis-summary{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 13px}
.analysis-summary small{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:2px}
.analysis-counts{display:flex;gap:6px}
.analysis-count{font-size:11px;border-radius:999px;padding:3px 8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}
.analysis-count.buy{color:#E5484D}.analysis-count.sell{color:#12B85A}.analysis-count.watch{color:#B78103}
.analysis-grid{display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:12px;align-items:start}
.analysis-list,.analysis-detail{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px;min-height:180px}
.analysis-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.analysis-section-head small{color:var(--dsw-alias-label-tertiary);font-size:11px}
.analysis-item{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center;width:100%;border:none;border-radius:8px;background:transparent;color:inherit;padding:7px 6px;text-align:left;cursor:pointer;font:inherit}
.analysis-item:hover,.analysis-item.is-active{background:var(--dsw-alias-interactive-bg-hover)}
.analysis-item-main{min-width:0;display:grid;gap:2px}
.analysis-item-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.analysis-item-main small{color:var(--dsw-alias-label-tertiary);font-size:10px}
.analysis-chip{display:inline-flex;align-items:center;border-radius:999px;padding:2px 6px;font-size:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.analysis-chip.buy{color:#E5484D;border-color:rgba(229,72,77,.35)}.analysis-chip.sell{color:#12B85A;border-color:rgba(18,184,90,.35)}.analysis-chip.watch{color:#B78103;border-color:rgba(183,129,3,.35)}
.analysis-score{font-weight:650;font-size:12px;min-width:34px;text-align:right}
.analysis-score.big{font-size:22px;min-width:0}
.analysis-detail-head{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:6px}
.analysis-detail-head small{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px;margin-top:2px}
.analysis-kv{display:flex;gap:8px;font-size:12px;margin:5px 0}
.analysis-text{font-size:12px;line-height:1.65;margin:6px 0;white-space:pre-wrap}
.analysis-muted{color:var(--dsw-alias-label-tertiary);font-size:10px}
.analysis-markdown{max-height:360px;overflow:auto;white-space:pre-wrap;font-family:inherit;font-size:12px;line-height:1.65;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;margin:8px 0}
.analysis-news{margin-top:8px;display:grid;gap:5px}
.analysis-news-row{display:grid;gap:2px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:5px}
.analysis-news-row strong{font-size:12px}.analysis-news-row small{font-size:11px;color:var(--dsw-alias-label-secondary)}
.analysis-history-list{display:grid;gap:4px}
.analysis-history-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;border:none;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;padding:8px 4px;text-align:left;cursor:pointer;font:inherit}
.analysis-history-row small{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px;margin-top:2px}
.analysis-connection{display:grid;gap:8px;max-width:760px}
.analysis-chat{display:grid;gap:8px;max-width:860px}
.analysis-chat-log{display:grid;gap:8px;min-height:140px}
.analysis-chat-row{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}
.analysis-chat-row.user{background:var(--dsw-alias-interactive-bg-hover)}
.analysis-chat-row.error{border-color:rgba(229,72,77,.4)}
.analysis-chat-row strong{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.analysis-chat-row p{white-space:pre-wrap;font-size:12px;line-height:1.65;margin:4px 0 0}
.analysis-hintcard{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.65}
.analysis-hintcard p{margin:4px 0}
.analysis-hintcard small{color:var(--dsw-alias-label-tertiary)}
.analysis-tasks{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 12px;display:grid;gap:6px;font-size:12px}
.analysis-tasks>small{color:var(--dsw-alias-label-tertiary)}
.analysis-task-list{display:grid;gap:4px}
.analysis-task{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,2fr) 110px;gap:8px;align-items:center}
.analysis-task small{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.analysis-disclaimer{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5}
@media(max-width:760px){.analysis-grid{grid-template-columns:1fr}.analysis-bar{align-items:flex-start;flex-direction:column}.analysis-actions{justify-content:flex-start}}
`
  const studioClone = (value) => JSON.parse(JSON.stringify(value))
  async function studioJson(path, options) {
    const response = await fetch(STUDIO_API + path, { cache: 'no-store', ...(options || {}) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
    return payload
  }
  function studioDefaultModule(type, theme) {
    const size = theme && theme.titleSize ? theme.titleSize : 11
    if (type === 'icon') return { type: 'icon', field: 'state', size: 46, weight: 1, align: 'left' }
    if (type === 'image') return { type: 'image', field: 'meme', maxWidth: 300, maxHeight: 300, radius: 12, weight: 1, align: 'center' }
    if (type === 'tasks') return { type: 'tasks', max: 3, size: theme && theme.bodySize ? theme.bodySize : 9, weight: 1, align: 'left' }
    if (type === 'quote') return { type: 'quote', size: theme && theme.bodySize ? theme.bodySize : 9, weight: 1, align: 'left', showName: true, showPrice: true, showPct: true, showVolume: true }
    if (type === 'indices') return { type: 'indices', size: theme && theme.bodySize ? theme.bodySize : 9, weight: 1, align: 'left', showName: true, showPct: true }
    if (type === 'divider') return { type: 'divider', weight: 1, align: 'left' }
    if (type === 'spacer') return { type: 'spacer', weight: 1, align: 'left' }
    return { type: 'text', field: 'message', size, bold: true, weight: 1, maxLines: 2, align: 'left', color: 'text', wrap: true }
  }
  function StudioButton({ children, onClick, disabled, primary, danger, small, title }) {
    return h('button', {
      type: 'button', title, disabled,
      className: `studio-btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}${small ? ' small' : ''}`,
      onClick,
    }, children)
  }
  function StudioField({ label, children }) {
    return h('label', { className: 'studio-field' }, h('span', null, label), children)
  }
  function StudioInput({ value, onChange, type = 'text', min, max, step, placeholder }) {
    return h('input', {
      className: 'studio-input', type, value: value ?? '', min, max, step, placeholder,
      onChange: (event) => onChange(type === 'number' ? Number(event.target.value) : event.target.value),
    })
  }
  function StudioSelect({ value, options, onChange }) {
    return h('select', { className: 'studio-select', value, onChange: (event) => onChange(event.target.value) },
      ...options.map(([option, label]) => h('option', { key: option, value: option }, label)))
  }
  function StudioColor({ value, onChange }) {
    const hex = /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : '#ffffff'
    return h('span', { className: 'studio-color' },
      h('input', { type: 'color', value: hex, onChange: (event) => onChange(event.target.value) }),
      h('input', { className: 'studio-input', value: value ?? '', onChange: (event) => onChange(event.target.value) }))
  }
  function StudioTextArea({ value, onChange, rows = 3 }) {
    return h('textarea', { className: 'studio-textarea', rows, value: value ?? '', onChange: (event) => onChange(event.target.value) })
  }
  function StudioIcon({ size = 18 }) {
    return h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('path', { d: 'M4 6.5h9.5a3 3 0 0 1 3 3V15H10a6 6 0 0 1-6-6V6.5Z' }),
    h('path', { d: 'M16.5 10.5H20v3h-3.5' }),
    h('path', { d: 'M8 19l2-3M13 19l2-3' }),
    h('circle', { cx: 18.5, cy: 4.5, r: 1.5 }))
  }
  function useStudioData() {
    const [data, setData] = useState(null)
    const [error, setError] = useState('')
    const load = useCallback(async () => {
      try {
        const [bubble, actions, memes] = await Promise.all([
          studioJson('/bubble'), studioJson('/actions'), studioJson('/memes'),
        ])
        setData({
          spec: bubble.spec, presets: bubble.presets || {},
          actions: actions.actions, catalog: actions.catalog || { clips: [], labels: {}, menu: [] },
          memes: memes.items || [], service: Boolean(memes.service),
        })
        setError('')
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      }
    }, [])
    useEffect(() => { void load() }, [load])
    return { data, setData, error, reload: load }
  }
  function ModuleEditor({ module, theme, onChange, onRemove }) {
    const set = (patch) => onChange({ ...module, ...patch })
    const kind = module.type
    return h('div', { className: 'studio-module' },
      h('div', { className: 'studio-module-head' },
        h(StudioSelect, {
          value: kind, options: STUDIO_MODULE_TYPES,
          onChange: (type) => onChange(studioDefaultModule(type, theme)),
        }),
        h(StudioButton, { small: true, danger: true, onClick: onRemove }, '删除')),
      kind === 'text' ? h(React.Fragment, null,
        h(StudioField, { label: '字段' },
          h(StudioSelect, { value: module.field || 'message', options: STUDIO_TEXT_FIELDS, onChange: (field) => set({ field }) })),
        module.field === 'text' ? h(StudioField, { label: '文字' }, h(StudioInput, { value: module.text || '', onChange: (text) => set({ text }) })) : null,
        h('div', { className: 'studio-inline' },
          h('label', { className: 'studio-check' }, h('input', { type: 'checkbox', checked: module.bold === true, onChange: (event) => set({ bold: event.target.checked }) }), '粗体'),
          h('label', { className: 'studio-check' }, h('input', { type: 'checkbox', checked: module.wrap !== false, onChange: (event) => set({ wrap: event.target.checked }) }), '换行')),
        h('div', { className: 'studio-grid' },
          h(StudioField, { label: '字号' }, h(StudioInput, { type: 'number', min: 6, max: 32, step: 0.5, value: module.size ?? 11, onChange: (size) => set({ size }) })),
          h(StudioField, { label: '最多行' }, h(StudioInput, { type: 'number', min: 1, max: 6, value: module.maxLines ?? 2, onChange: (maxLines) => set({ maxLines }) }))),
        h(StudioField, { label: '颜色（主题 token 或 #hex）' }, h(StudioColor, { value: module.color || 'text', onChange: (color) => set({ color }) })),
        h(StudioField, { label: '对齐' }, h(StudioSelect, { value: module.align || 'left', options: [['left', '左'], ['center', '中'], ['right', '右']], onChange: (align) => set({ align }) })))
        : null,
      kind === 'icon' ? h(StudioField, { label: '大小' }, h(StudioInput, { type: 'number', min: 20, max: 64, value: module.size ?? 46, onChange: (size) => set({ size }) })) : null,
      kind === 'image' ? h(React.Fragment, null,
        h(StudioField, { label: '最大宽' }, h(StudioInput, { type: 'number', min: 40, max: 400, value: module.maxWidth ?? 300, onChange: (maxWidth) => set({ maxWidth }) })),
        h(StudioField, { label: '最大高' }, h(StudioInput, { type: 'number', min: 40, max: 400, value: module.maxHeight ?? 300, onChange: (maxHeight) => set({ maxHeight }) })),
        h(StudioField, { label: '圆角' }, h(StudioInput, { type: 'number', min: 0, max: 32, value: module.radius ?? 12, onChange: (radius) => set({ radius }) }))) : null,
      kind === 'tasks' ? h(StudioField, { label: '最多几行' }, h(StudioInput, { type: 'number', min: 1, max: 5, value: module.max ?? 3, onChange: (max) => set({ max }) })) : null,
      kind === 'quote' ? h(React.Fragment, null,
        h(StudioField, { label: '字号' }, h(StudioInput, { type: 'number', min: 6, max: 24, step: 0.5, value: module.size ?? 9, onChange: (size) => set({ size }) })),
        h('div', { className: 'studio-inline' },
          h('label', { className: 'studio-check' }, h('input', { type: 'checkbox', checked: module.showName !== false, onChange: (event) => set({ showName: event.target.checked }) }), '名称'),
          h('label', { className: 'studio-check' }, h('input', { type: 'checkbox', checked: module.showPrice !== false, onChange: (event) => set({ showPrice: event.target.checked }) }), '股价'),
          h('label', { className: 'studio-check' }, h('input', { type: 'checkbox', checked: module.showPct !== false, onChange: (event) => set({ showPct: event.target.checked }) }), '涨跌幅'),
          h('label', { className: 'studio-check' }, h('input', { type: 'checkbox', checked: module.showVolume !== false, onChange: (event) => set({ showVolume: event.target.checked }) }), '量比'))) : null,
      kind === 'indices' ? h(React.Fragment, null,
        h(StudioField, { label: '字号' }, h(StudioInput, { type: 'number', min: 6, max: 24, step: 0.5, value: module.size ?? 9, onChange: (size) => set({ size }) })),
        h('div', { className: 'studio-inline' },
          h('label', { className: 'studio-check' }, h('input', { type: 'checkbox', checked: module.showName !== false, onChange: (event) => set({ showName: event.target.checked }) }), '名称'),
          h('label', { className: 'studio-check' }, h('input', { type: 'checkbox', checked: module.showPct !== false, onChange: (event) => set({ showPct: event.target.checked }) }), '涨跌幅'))) : null,
      kind === 'spacer' ? h(StudioField, { label: '权重' }, h(StudioInput, { type: 'number', min: 0.05, max: 8, step: 0.05, value: module.weight ?? 1, onChange: (weight) => set({ weight }) })) : null,
      kind === 'text' || kind === 'tasks' || kind === 'quote' || kind === 'indices' ? h(StudioField, { label: '宽度权重' }, h(StudioInput, { type: 'number', min: 0.05, max: 8, step: 0.05, value: module.weight ?? 1, onChange: (weight) => set({ weight }) })) : null)
  }
  function BubblePanel({ spec, presets, updateSpec, previewRev, previewScene, setPreviewScene, onPreview }) {
    const theme = spec.theme || {}
    const sceneNames = Object.keys(spec.scenes || {})
    const [sceneName, setSceneName] = useState(previewScene || sceneNames[0] || 'status')
    const scene = spec.scenes[sceneName] || spec.scenes[sceneNames[0]] || { rows: [] }
    useEffect(() => {
      if (!spec.scenes[sceneName] && sceneNames[0]) setSceneName(sceneNames[0])
    }, [spec, sceneName, sceneNames.join(',')])
    const setTheme = (patch) => updateSpec((next) => { next.theme = { ...next.theme, ...patch } })
    const applyPreset = (id) => updateSpec((next) => {
      const preset = presets[id]
      if (!preset) return
      next.theme = { ...next.theme, ...(preset.theme || {}), preset: id }
    })
    const updateScene = (fn) => updateSpec((next) => {
      const current = next.scenes[sceneName] || scene
      next.scenes[sceneName] = current
      fn(current)
    })
    const updateRow = (rowIndex, fn) => updateScene((current) => { const row = current.rows[rowIndex]; if (row) fn(row) })
    const addRow = () => updateScene((current) => {
      current.rows = current.rows || []
      current.rows.push({ gap: 8, align: 'stretch', modules: [studioDefaultModule('text', theme)] })
    })
    const addModule = (rowIndex) => updateRow(rowIndex, (row) => { row.modules = row.modules || []; row.modules.push(studioDefaultModule('text', theme)) })
    const removeModule = (rowIndex, moduleIndex) => updateRow(rowIndex, (row) => { row.modules.splice(moduleIndex, 1) })
    const removeRow = (rowIndex) => updateScene((current) => { current.rows.splice(rowIndex, 1) })
    const addScene = () => {
      const name = `custom${Object.keys(spec.scenes || {}).length + 1}`
      updateSpec((next) => {
        next.scenes[name] = { name: '新场景', ttlMs: 5000, rows: [{ gap: 8, modules: [studioDefaultModule('text', theme)] }] }
      })
      setSceneName(name)
    }
    return h('div', { className: 'studio-columns' },
      h('div', { className: 'studio-stack' },
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' }, '外观'),
          h('div', { className: 'studio-presets' },
            ...Object.entries(presets).map(([id, preset]) => h(StudioButton, { key: id, small: true, onClick: () => applyPreset(id) }, preset.label || id))),
          h('div', { className: 'studio-grid' },
            h(StudioField, { label: '宽度' }, h(StudioInput, { type: 'number', min: 280, max: 560, value: theme.width, onChange: (width) => setTheme({ width }) })),
            h(StudioField, { label: '圆角' }, h(StudioInput, { type: 'number', min: 0, max: 48, value: theme.radius, onChange: (radius) => setTheme({ radius }) })),
            h(StudioField, { label: '内边距' }, h(StudioInput, { type: 'number', min: 8, max: 32, value: theme.padding, onChange: (padding) => setTheme({ padding }) })),
            h(StudioField, { label: '透明度' }, h(StudioInput, { type: 'number', min: 0.5, max: 1, step: 0.01, value: theme.opacity, onChange: (opacity) => setTheme({ opacity }) })),
            h(StudioField, { label: '标题字号' }, h(StudioInput, { type: 'number', min: 6, max: 32, step: 0.5, value: theme.titleSize, onChange: (titleSize) => setTheme({ titleSize }) })),
            h(StudioField, { label: '正文字号' }, h(StudioInput, { type: 'number', min: 6, max: 32, step: 0.5, value: theme.bodySize, onChange: (bodySize) => setTheme({ bodySize }) }))),
          h('div', { className: 'studio-grid' },
            h(StudioField, { label: '背景' }, h(StudioColor, { value: theme.background, onChange: (background) => setTheme({ background }) })),
            h(StudioField, { label: '边框' }, h(StudioColor, { value: theme.border, onChange: (border) => setTheme({ border }) })),
            h(StudioField, { label: '文字' }, h(StudioColor, { value: theme.text, onChange: (text) => setTheme({ text }) })),
            h(StudioField, { label: '次要文字' }, h(StudioColor, { value: theme.muted, onChange: (muted) => setTheme({ muted }) }))),
          h(StudioField, { label: '字体' }, h(StudioInput, { value: theme.font, onChange: (font) => setTheme({ font }) }))),
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' },
            '场景',
            h('div', { className: 'studio-inline' },
              h(StudioButton, { small: true, onClick: addScene }, '新增场景'))),
          h('div', { className: 'studio-inline' },
            h(StudioSelect, { value: sceneName, options: sceneNames.map((name) => [name, name]), onChange: (name) => { setSceneName(name); setPreviewScene(name) } }),
            h(StudioButton, { small: true, onClick: () => onPreview(sceneName) }, '预览此场景')),
          h('div', { className: 'studio-hint' }, `共 ${scene.rows?.length || 0} 行；预览由桌宠同一渲染器生成。`),
          ...(scene.rows || []).map((row, rowIndex) => h('div', { className: 'studio-row', key: `row-${rowIndex}` },
            h('div', { className: 'studio-row-head' },
              h('span', { className: 'studio-row-title' }, `第 ${rowIndex + 1} 行`),
              h('div', { className: 'studio-inline' },
                h(StudioButton, { small: true, onClick: () => addModule(rowIndex) }, '加模块'),
                h(StudioButton, { small: true, danger: true, onClick: () => removeRow(rowIndex) }, '删行'))),
            h('div', { className: 'studio-modules' },
              ...(row.modules || []).map((module, moduleIndex) => h(ModuleEditor, {
                key: `module-${rowIndex}-${moduleIndex}`, module, theme,
                onChange: (next) => updateRow(rowIndex, (target) => { target.modules[moduleIndex] = next }),
                onRemove: () => removeModule(rowIndex, moduleIndex),
              }))))),
          h(StudioButton, { small: true, onClick: addRow }, '加一行')),
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' }, '点击与台词'),
          h('div', { className: 'studio-hint' }, '点一下桌宠时按顺序展示这些场景；点气泡继续推进。'),
          ...(spec.clickSequence || []).map((entry, index) => h('div', { className: 'studio-inline', key: `click-${index}` },
            h(StudioSelect, { value: entry.scene, options: sceneNames.map((name) => [name, name]), onChange: (value) => updateSpec((next) => { next.clickSequence[index].scene = value }) }),
            h(StudioInput, { type: 'number', min: 0.1, max: 10, step: 0.1, value: entry.weight, onChange: (weight) => updateSpec((next) => { next.clickSequence[index].weight = weight }) }),
            h(StudioButton, { small: true, danger: true, onClick: () => updateSpec((next) => { next.clickSequence.splice(index, 1) }) }, '删除'))),
          h(StudioButton, { small: true, onClick: () => updateSpec((next) => { next.clickSequence.push({ scene: sceneName, weight: 1 }) }) }, '加一条'),
          h('div', { className: 'studio-divider' }),
          h('div', { className: 'studio-hint' }, '随机台词按权重抽取，不在上一句重复。'),
          ...(spec.randomLines || []).map((entry, index) => h('div', { key: `line-${index}`, className: 'studio-field' },
            h('div', { className: 'studio-inline' },
              h('span', { className: 'studio-row-title' }, `第 ${index + 1} 组`),
              h(StudioInput, { type: 'number', min: 0.1, max: 10, step: 0.1, value: entry.weight, onChange: (weight) => updateSpec((next) => { next.randomLines[index].weight = weight }) }),
              h(StudioButton, { small: true, danger: true, onClick: () => updateSpec((next) => { next.randomLines.splice(index, 1) }) }, '删除')),
            h(StudioTextArea, { value: (entry.lines || []).join('\n'), onChange: (text) => updateSpec((next) => { next.randomLines[index].lines = text.split('\n').map((line) => line.trim()).filter(Boolean) }) }))),
          h(StudioButton, { small: true, onClick: () => updateSpec((next) => { next.randomLines.push({ weight: 1, lines: ['新台词'] }) }) }, '加一组台词'))),
      h('aside', { className: 'studio-preview' },
        h('div', { className: 'studio-card-title' }, '真机预览'),
        h('div', { className: 'studio-preview-box' },
          previewRev > 0
            ? h('img', { src: `${STUDIO_API}/bubble-preview.png?rev=${previewRev}`, alt: '气泡预览' })
            : h('span', { className: 'studio-hint' }, '点右上角「预览」让桌宠渲染当前草稿')),
        h(StudioButton, { onClick: () => onPreview(sceneName) }, '生成当前场景预览')))
  }
  function ActionsPanel({ actions, catalog, updateActions }) {
    const [playing, setPlaying] = useState('')
    const play = async (clip) => {
      setPlaying(clip)
      try { await studioJson('/actions/play', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clip }) }) } catch {} finally { setPlaying('') }
    }
    const setCategory = (index, patch) => updateActions((next) => { next.categories[index] = { ...next.categories[index], ...patch } })
    const setClick = (region, patch) => updateActions((next) => { next.click[region] = { ...next.click[region], ...patch } })
    return h('div', { className: 'studio-columns' },
      h('div', { className: 'studio-stack' },
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' }, '空闲动作分类'),
          h('div', { className: 'studio-hint' }, '按权重抽分类，再抽具体动作；最近几个不重复。'),
          ...(actions.categories || []).map((category, index) => h('div', { className: 'studio-row', key: category.id || index },
            h('div', { className: 'studio-inline' },
              h(StudioInput, { value: category.label || category.id, onChange: (label) => setCategory(index, { label }) }),
              h(StudioInput, { type: 'number', min: 0.1, max: 100, value: category.weight, onChange: (weight) => setCategory(index, { weight }) })),
            h(StudioField, { label: '动作 clip（逗号分隔）' },
              h(StudioInput, {
                value: (category.clips || []).join(', '),
                onChange: (text) => setCategory(index, { clips: text.split(',').map((clip) => clip.trim()).filter(Boolean) }),
              })))),
          h('div', { className: 'studio-inline' },
            h(StudioButton, { small: true, onClick: () => updateActions((next) => { next.categories.push({ id: `cat${next.categories.length + 1}`, label: '新分类', weight: 10, clips: ['idle_stretch'] }) }) }, '加分类'))),
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' }, '点击反应'),
          ...STUDIO_CLICK_REGIONS.map(([region, label]) => h('div', { key: region, className: 'studio-row' },
            h('div', { className: 'studio-row-title' }, label),
            h(StudioField, { label: 'clips（逗号分隔）' },
              h(StudioInput, { value: (actions.click?.[region]?.clips || []).join(', '), onChange: (text) => setClick(region, { clips: text.split(',').map((clip) => clip.trim()).filter(Boolean) }) })),
            h(StudioField, { label: '台词（一行一句）' },
              h(StudioTextArea, { rows: 2, value: (actions.click?.[region]?.lines || []).join('\n'), onChange: (text) => setClick(region, { lines: text.split('\n').map((line) => line.trim()).filter(Boolean) }) })))))),
      h('div', { className: 'studio-stack' },
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' }, '动作库'),
          h('div', { className: 'studio-hint' }, `共 ${catalog.clips?.length || 0} 个 clip；点一下让桌宠试播。`),
          h('div', { className: 'studio-inline' },
            ...(catalog.clips || []).map((clip) => h(StudioButton, { key: clip, small: true, disabled: playing === clip, onClick: () => play(clip) }, catalog.labels?.[clip] || clip)))),
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' }, '说明'),
          h('div', { className: 'studio-hint' }, '动作包可以后续通过 ~/.dsh/dafeiyu/actions/<pack>/manifest.json 扩展；本次先开放分类权重、点击池和试播。'))))
  }
  function MemesPanel({ memes, service, reload }) {
    const [tag, setTag] = useState('daily')
    const [caption, setCaption] = useState('')
    const [busy, setBusy] = useState(false)
    const [picked, setPicked] = useState(null)
    const [message, setMessage] = useState('')
    const upload = async (file) => {
      if (!file) return
      if (file.size > 8 * 1024 * 1024) { setMessage('图片不能超过 8MB'); return }
      setBusy(true)
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
          reader.onerror = () => reject(new Error('读取图片失败'))
          reader.readAsDataURL(file)
        })
        await studioJson('/memes', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data, tag, caption }),
        })
        setCaption('')
        setMessage('已上传')
        await reload()
      } catch (error) { setMessage(error.message) } finally { setBusy(false) }
    }
    const remove = async (id) => {
      try { await studioJson(`/memes?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); await reload() } catch (error) { setMessage(error.message) }
    }
    const pick = async () => {
      try {
        const result = await studioJson('/memes/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag }) })
        setPicked(result.meme)
      } catch (error) { setMessage(error.message) }
    }
    return h('div', { className: 'studio-columns' },
      h('div', { className: 'studio-stack' },
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' }, '图源', h('span', { className: 'studio-hint' }, service ? '已连接 dsh-meme' : '未安装 dsh-meme（本地图库可用）')),
          h('div', { className: 'studio-hint' }, service
            ? '斗图时优先使用 dsh-meme 的大肥鱼图库；本地图库作为兜底。'
            : '安装 dsh-meme 后，斗图会优先使用它的图库；也可以先上传本地表情包。')),
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' }, '上传本地表情'),
          h('div', { className: 'studio-inline' },
            h(StudioSelect, { value: tag, options: [['daily', '日常'], ['happy', '开心'], ['angry', '生气'], ['sad', '难过'], ['shy', '害羞'], ['confused', '疑惑'], ['success', '完成'], ['error', '出错'], ['work', '工作']], onChange: setTag }),
            h(StudioInput, { value: caption, onChange: setCaption, placeholder: '说明（可选）' })),
          h('div', { className: 'studio-inline' },
            h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', disabled: busy, onChange: (event) => void upload(event.target.files?.[0]) }),
            h(StudioButton, { small: true, onClick: pick }, '抽一张测试')),
          picked ? h('div', { className: 'studio-hint' }, `抽到：${picked.caption || picked.path || picked.tag}`) : null,
          message ? h('div', { className: 'studio-hint' }, message) : null)),
      h('div', { className: 'studio-stack' },
        h('section', { className: 'studio-card' },
          h('div', { className: 'studio-card-title' }, `本地图库（${memes.length}）`),
          memes.length === 0
            ? h('div', { className: 'studio-hint' }, '还没有本地表情包。上传 PNG / GIF / WebP 后，桌宠斗图会用到。')
            : h('div', { className: 'studio-meme-grid' },
                ...memes.map((meme) => h('div', { className: 'studio-meme', key: meme.id },
                  h('img', { src: `${STUDIO_API}/memes/image?id=${encodeURIComponent(meme.id)}`, alt: meme.caption || meme.tag }),
                  h('small', { title: meme.caption || '' }, meme.caption || '(无说明)'),
                  h('div', { className: 'studio-inline' },
                    h('span', { className: 'studio-hint' }, meme.tag),
                    h(StudioButton, { small: true, danger: true, onClick: () => void remove(meme.id) }, '删除'))))))))
  }
  function StudioPage() {
    const { data, setData, error, reload } = useStudioData()
    const [tab, setTab] = useState('bubble')
    const [dirty, setDirty] = useState(false)
    const [busy, setBusy] = useState('')
    const [message, setMessage] = useState('')
    const [previewRev, setPreviewRev] = useState(0)
    const [previewScene, setPreviewScene] = useState('status')
    const updateSpec = useCallback((fn) => {
      setData((current) => {
        if (!current) return current
        const spec = studioClone(current.spec)
        fn(spec)
        return { ...current, spec }
      })
      setDirty(true)
    }, [setData])
    const updateActions = useCallback((fn) => {
      setData((current) => {
        if (!current) return current
        const actions = studioClone(current.actions)
        fn(actions)
        return { ...current, actions }
      })
      setDirty(true)
    }, [setData])
    const save = async () => {
      setBusy('save'); setMessage('')
      try {
        const [bubble, actions] = await Promise.all([
          studioJson('/bubble', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: data.spec }) }),
          studioJson('/actions', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actions: data.actions }) }),
        ])
        setData((current) => ({ ...current, spec: bubble.spec, actions: actions.actions }))
        setDirty(false)
        setMessage('已保存，桌宠会立即生效')
      } catch (error) { setMessage(`保存失败：${error.message}`) } finally { setBusy('') }
    }
    const preview = async (scene) => {
      setBusy('preview'); setMessage('')
      try {
        const result = await studioJson('/preview', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec: data.spec, scene: scene || previewScene, data: STUDIO_PREVIEW_DATA }),
        })
        setPreviewRev(result.rev || Date.now())
        setMessage('预览已由桌宠渲染')
      } catch (error) { setMessage(`预览失败：${error.message}`) } finally { setBusy('') }
    }
    const reloadMemes = async () => {
      const memes = await studioJson('/memes')
      setData((current) => current ? { ...current, memes: memes.items || [], service: Boolean(memes.service) } : current)
    }
    if (error) return h('div', { className: 'studio-root' }, h('style', null, STUDIO_CSS), h('div', { className: 'studio-empty' }, `读取工坊数据失败：${error}`))
    if (!data) return h('div', { className: 'studio-root' }, h('style', null, STUDIO_CSS), h('div', { className: 'studio-empty' }, '正在读取大肥鱼工坊…'))
    return h('div', { className: 'studio-root' },
      h('style', null, STUDIO_CSS),
      h('header', { className: 'studio-head' },
        h('div', null, h('h1', null, '大肥鱼工坊'), h('span', { className: 'studio-sub' }, '动作、气泡、斗图、分析与设置')),
        h('nav', { className: 'studio-tabs' },
          ...[['bubble', '气泡'], ['actions', '动作'], ['memes', '斗图'], ['analysis', '分析'], ['settings', '设置']].map(([id, label]) => h('button', {
            key: id, type: 'button', className: `studio-tab${tab === id ? ' is-active' : ''}`, onClick: () => setTab(id),
          }, label))),
        h('div', { className: 'studio-head-actions' },
          tab === 'settings'
            ? h('span', { className: 'studio-msg' }, '设置即时生效，修改会直接保存到宿主')
            : tab === 'analysis'
              ? h('span', { className: 'studio-msg' }, 'AI 分析仅供研究，不构成投资建议')
              : h(React.Fragment, null,
                message ? h('span', { className: 'studio-msg' }, message) : (dirty ? h('span', { className: 'studio-msg' }, '未保存') : null),
                h(StudioButton, { primary: true, disabled: busy === 'save' || !dirty, onClick: save }, busy === 'save' ? '保存中…' : '保存'),
                h(StudioButton, { disabled: busy === 'preview', onClick: () => void preview() }, busy === 'preview' ? '生成中…' : '预览')))),
      tab === 'bubble'
        ? h(BubblePanel, { spec: data.spec, presets: data.presets, updateSpec, previewRev, previewScene, setPreviewScene, onPreview: preview })
        : tab === 'actions'
          ? h(ActionsPanel, { actions: data.actions, catalog: data.catalog, updateActions })
          : tab === 'analysis'
            ? h(AnalysisPanel)
            : tab === 'settings'
              ? h(CompanionSettings, { embedded: true })
              : h(MemesPanel, { memes: data.memes, service: data.service, reload: reloadMemes }))
  }

  const ANALYSIS_VIEWS = [['dashboard', '仪表盘'], ['history', '历史'], ['chat', '问股'], ['connection', '连接']]

  function analysisGroup(item) {
    const action = String(item?.action ?? '').toLowerCase()
    const advice = String(item?.advice ?? '')
    if (['buy', 'add'].includes(action) || /买入|加仓/.test(advice)) return 'buy'
    if (['sell', 'reduce', 'avoid'].includes(action) || /卖出|减仓|回避/.test(advice)) return 'sell'
    if (['watch', 'hold', 'alert'].includes(action) || /观望|持有|警惕/.test(advice)) return 'watch'
    return 'unknown'
  }

  function AnalysisPanel() {
    const [status, setStatus] = useState(null)
    const [stocks, setStocks] = useState({ items: [], error: '' })
    const [tasks, setTasks] = useState([])
    const [view, setView] = useState('dashboard')
    const [selected, setSelected] = useState('')
    const [report, setReport] = useState(null)
    const [history, setHistory] = useState(null)
    const [config, setConfig] = useState(null)
    const [single, setSingle] = useState('')
    const [busy, setBusy] = useState('')
    const [message, setMessage] = useState('')
    const [chatInput, setChatInput] = useState('')
    const [chatLog, setChatLog] = useState([])
    const [chatBusy, setChatBusy] = useState(false)
    const [chatSession, setChatSession] = useState('')
    const lastActive = useRef(false)

    const loadStatus = useCallback(async () => {
      try {
        const next = await studioJson('/analysis/status')
        setStatus(next)
        return next
      } catch (error) {
        setStatus({ enabled: false, connected: false, error: error.message })
        return null
      }
    }, [])
    const loadStocks = useCallback(async () => {
      try {
        const next = await studioJson('/analysis/stocks')
        setStocks(next)
        return next
      } catch (error) {
        setStocks({ items: [], error: error.message })
        return null
      }
    }, [])
    const loadTasks = useCallback(async () => {
      try {
        const next = await studioJson('/analysis/tasks')
        const rows = Array.isArray(next.tasks) ? next.tasks : []
        setTasks(rows)
        const active = rows.some((task) => !['completed', 'success', 'failed', 'error', 'cancelled', 'canceled', 'done', 'timeout'].includes(String(task.status || '').toLowerCase()))
        if (lastActive.current && !active) void loadStocks()
        lastActive.current = active
        return rows
      } catch {
        return []
      }
    }, [loadStocks])
    const refresh = useCallback(async () => {
      setBusy('refresh')
      await Promise.all([loadStatus(), loadStocks(), loadTasks()])
      setBusy('')
    }, [loadStatus, loadStocks, loadTasks])
    const loadHistory = useCallback(async () => {
      setBusy('history')
      try {
        setHistory(await studioJson('/analysis/history?page=0&pageSize=30'))
      } catch (error) {
        setHistory({ items: [], error: error.message })
      } finally { setBusy('') }
    }, [])
    const openReport = useCallback(async (item) => {
      if (!item) return
      setSelected(item.code)
      setReport(null)
      if (!item.reportId) return
      setBusy('report')
      try {
        setReport(await studioJson(`/analysis/report?id=${encodeURIComponent(item.reportId)}`))
      } catch (error) {
        setMessage(`报告读取失败：${error.message}`)
      } finally { setBusy('') }
    }, [])
    const analyze = useCallback(async (codes) => {
      setBusy('analyze'); setMessage('')
      try {
        const result = await studioJson('/analysis/analyze', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(codes ? { codes } : {}),
        })
        setMessage(result.taskIds?.length ? `已提交 ${result.taskIds.length} 个分析任务` : '分析任务已提交')
        await loadTasks()
        await loadStocks()
      } catch (error) {
        setMessage(`提交失败：${error.message}`)
      } finally { setBusy('') }
    }, [loadStocks, loadTasks])
    const loadConfig = useCallback(async () => {
      try { setConfig(await studioJson('/config')) } catch (error) { setMessage(`配置读取失败：${error.message}`) }
    }, [])
    const sendChat = useCallback(async () => {
      const text = chatInput.trim()
      if (!text || chatBusy) return
      setChatBusy(true); setChatInput('')
      setChatLog((prev) => [...prev, { role: 'user', text }])
      try {
        const result = await studioJson('/analysis/chat', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: text, sessionId: chatSession }),
        })
        if (result.session_id) setChatSession(result.session_id)
        setChatLog((prev) => [...prev, { role: 'assistant', text: result.content || result.message || 'DSA 没有返回内容' }])
      } catch (error) {
        setChatLog((prev) => [...prev, { role: 'error', text: error.message }])
      } finally { setChatBusy(false) }
    }, [chatInput, chatBusy, chatSession])
    const marketReview = useCallback(async () => {
      setBusy('review'); setMessage('')
      try {
        await studioJson('/analysis/market-review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        setMessage('大盘复盘任务已提交')
        await loadTasks()
      } catch (error) {
        setMessage(`大盘复盘提交失败：${error.message}`)
      } finally { setBusy('') }
    }, [loadTasks])
    const writeConfig = useCallback(async (field, value) => {
      setBusy(`config-${field}`); setMessage('')
      try {
        const next = await studioJson('/config', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        })
        setConfig(next)
        await loadStatus()
        await loadStocks()
        setMessage('分析设置已保存')
      } catch (error) {
        setMessage(`保存失败：${error.message}`)
      } finally { setBusy('') }
    }, [loadStatus, loadStocks])
    const dockerAction = useCallback(async (action) => {
      setBusy(`docker-${action}`); setMessage('')
      try {
        const result = await studioJson('/analysis/docker', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        setMessage(result.ok ? `DSA 容器 ${action} 成功` : `DSA 容器 ${action} 失败：${result.error || result.output || ''}`)
        await loadStatus()
      } catch (error) {
        setMessage(`DSA 容器 ${action} 失败：${error.message}`)
      } finally { setBusy('') }
    }, [loadStatus])
    const syncWatchlist = useCallback(async () => {
      setBusy('sync'); setMessage('')
      try {
        const result = await studioJson('/analysis/sync-watchlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        setMessage(result.updated_keys?.includes('STOCK_LIST') ? '养鱼自选已同步到 DSA 的 STOCK_LIST' : '已提交自选同步，请刷新 DSA 配置确认')
      } catch (error) {
        setMessage(`同步自选失败：${error.message}`)
      } finally { setBusy('') }
    }, [])

    useEffect(() => { void refresh() }, [refresh])
    useEffect(() => {
      if (!status?.enabled) return undefined
      const timer = setInterval(() => { void loadTasks() }, 3000)
      return () => clearInterval(timer)
    }, [status?.enabled, loadTasks])
    useEffect(() => {
      if (view === 'history' && !history) void loadHistory()
      if (view === 'connection' && !config) void loadConfig()
    }, [view, history, config, loadHistory, loadConfig])

    const items = Array.isArray(stocks?.items) ? stocks.items : []
    const selectedItem = items.find((item) => item.code === selected) || null
    const counts = { buy: 0, sell: 0, watch: 0, unknown: 0 }
    for (const item of items) if (item.reportId || item.analyzedAt) counts[analysisGroup(item)] += 1
    const activeTasks = tasks.filter((task) => !['completed', 'success', 'failed', 'error', 'cancelled', 'canceled', 'done', 'timeout'].includes(String(task.status || '').toLowerCase()))
    const openDsa = () => {
      const url = status?.baseUrl || config?.analysisBaseUrl
      if (url) window.open(url, '_blank', 'noopener')
    }

    return h('div', { className: 'analysis-root' },
      h('div', { className: 'analysis-bar' },
        h('div', { className: 'analysis-status' },
          h('span', { className: `analysis-dot${status?.connected ? ' online' : ''}` }),
          h('strong', null, status?.connected ? 'DSA 已连接' : status?.enabled ? 'DSA 未连接' : 'DSA 未启用'),
          h('small', null, status?.baseUrl || config?.analysisBaseUrl || ''),
          status?.error ? h('small', { className: 'analysis-error' }, status.error) : null,
        ),
        h('div', { className: 'analysis-actions' },
          status?.lastRunAt ? h('small', null, `最近 ${new Date(status.lastRunAt).toLocaleString()}`) : null,
          h(StudioButton, { small: true, disabled: busy === 'refresh', onClick: () => void refresh() }, busy === 'refresh' ? '刷新中…' : '刷新'),
          h(StudioButton, { small: true, disabled: busy === 'analyze' || !status?.enabled, onClick: () => void analyze() }, busy === 'analyze' ? '提交中…' : '分析自选'),
          h(StudioButton, { small: true, disabled: busy === 'sync' || !status?.enabled, onClick: () => void syncWatchlist() }, busy === 'sync' ? '同步中…' : '同步自选到 DSA'),
          h(StudioButton, { small: true, disabled: busy === 'review' || !status?.enabled, onClick: () => void marketReview() }, busy === 'review' ? '提交中…' : '大盘复盘'),
          h(StudioButton, { small: true, onClick: openDsa }, '打开 DSA'),
        )),
      h('nav', { className: 'analysis-subnav' },
        ...ANALYSIS_VIEWS.map(([id, label]) => h('button', {
          key: id, type: 'button', className: `analysis-subtab${view === id ? ' is-active' : ''}`,
          onClick: () => setView(id),
        }, label))),
      message ? h('div', { className: 'analysis-notice' }, message) : null,
      !status?.enabled
        ? h('div', { className: 'analysis-empty' },
            h('strong', null, 'DSA 分析还没有启用'),
            h('p', null, 'DSA 是独立的 Docker/FastAPI 服务；大肥鱼只连接它，不复制模型或数据源 Key。'),
            h('div', { className: 'analysis-inline' },
              h(StudioButton, { primary: true, onClick: () => setView('connection') }, '去连接设置'),
              h('small', null, '默认地址 http://127.0.0.1:8000')))
        : view === 'history'
          ? h('div', { className: 'analysis-history' },
              h('div', { className: 'analysis-section-head' },
                h('strong', null, '历史分析'), h(StudioButton, { small: true, onClick: () => void loadHistory() }, '刷新历史')),
              !history ? h('div', { className: 'analysis-empty' }, '正在读取历史…')
                : history.error ? h('div', { className: 'analysis-empty' }, history.error)
                  : (history.items || []).length === 0
                    ? h('div', { className: 'analysis-empty' }, '还没有历史分析。先在仪表盘分析自选股。')
                    : h('div', { className: 'analysis-history-list' },
                        ...(history.items || []).map((item) => h('button', {
                          key: `${item.id || item.code}-${item.analyzedAt}`,
                          type: 'button', className: 'analysis-history-row',
                          onClick: () => { setView('dashboard'); void openReport(item) },
                        },
                        h('span', null, h('strong', null, item.name || item.code), h('small', null, item.analyzedAt || '')),
                        h('span', { className: `analysis-chip ${analysisGroup(item)}` }, item.actionLabel || item.advice || item.trend || '未分析'),
                        h('span', { className: 'analysis-score' }, item.score == null ? '—' : item.score),
                        ))))
          : view === 'chat'
            ? h('div', { className: 'analysis-chat' },
                h('div', { className: 'analysis-section-head' },
                  h('strong', null, 'DSA Agent 问股'), h('small', null, '多轮策略问股，需要 DSA 开启 AGENT_MODE')),
                h('div', { className: 'analysis-chat-log' },
                  chatLog.length === 0 ? h('div', { className: 'analysis-empty' }, '问 DSA：例如「用均线分析 600519」「腾讯现在适合加仓吗？」') : null,
                  ...chatLog.map((entry, index) => h('div', { key: index, className: `analysis-chat-row ${entry.role}` },
                    h('strong', null, entry.role === 'user' ? '我' : entry.role === 'assistant' ? 'DSA' : '错误'),
                    h('p', null, entry.text)))),
                h('div', { className: 'analysis-inline' },
                  h(StudioInput, { value: chatInput, onChange: setChatInput, placeholder: '输入问题；只发送给本地 DSA' }),
                  h(StudioButton, { small: true, disabled: chatBusy || !chatInput.trim(), onClick: () => void sendChat() }, chatBusy ? '思考中…' : '发送')),
                h('small', { className: 'analysis-disclaimer' }, '问股内容由 DSA 生成，仅供研究。'))
          : view === 'connection'
            ? h('div', { className: 'analysis-connection' },
                h('div', { className: 'analysis-section-head' },
                  h('strong', null, 'DSA 连接'), h(StudioButton, { small: true, onClick: openDsa }, '打开 DSA 工作台')),
                !config ? h('div', { className: 'analysis-empty' }, '正在读取配置…')
                  : h(React.Fragment, null,
                      h(StudioField, { label: '启用 DSA 分析' },
                        h('input', { type: 'checkbox', checked: config.analysisEnabled === true, onChange: (event) => void writeConfig('analysisEnabled', event.target.checked) })),
                      h(StudioField, { label: 'DSA 地址' }, h(StudioInput, {
                        value: config.analysisBaseUrl ?? '', onChange: (value) => setConfig((prev) => ({ ...prev, analysisBaseUrl: value })),
                        placeholder: 'http://127.0.0.1:8000',
                      })),
                      h('div', { className: 'analysis-inline' },
                        h(StudioButton, { small: true, disabled: busy === 'config-analysisBaseUrl', onClick: () => void writeConfig('analysisBaseUrl', config.analysisBaseUrl) }, '保存地址')),
                      h(StudioField, { label: '每日分析时间' }, h(StudioInput, {
                        value: config.analysisSchedule ?? '', onChange: (value) => setConfig((prev) => ({ ...prev, analysisSchedule: value })),
                        placeholder: '18:00（工作日；留空关闭）',
                      })),
                      h('div', { className: 'analysis-inline' },
                        h(StudioButton, { small: true, onClick: () => void writeConfig('analysisSchedule', config.analysisSchedule) }, '保存时间')),
                      h(StudioField, { label: '报告类型' }, h(StudioSelect, {
                        value: config.analysisReportType ?? 'detailed',
                        options: [['simple', '简短'], ['detailed', '详细'], ['brief', '摘要']],
                        onChange: (value) => void writeConfig('analysisReportType', value),
                      })),
                      h(StudioField, { label: '桌宠摘要' }, h('input', {
                        type: 'checkbox', checked: config.analysisPetSummary !== false,
                        onChange: (event) => void writeConfig('analysisPetSummary', event.target.checked),
                      })),
                      h(StudioField, { label: '容器名' }, h(StudioInput, {
                        value: config.analysisContainer ?? '', onChange: (value) => setConfig((prev) => ({ ...prev, analysisContainer: value })),
                      })),
                      h('div', { className: 'analysis-inline' },
                        h(StudioButton, { small: true, onClick: () => void writeConfig('analysisContainer', config.analysisContainer) }, '保存容器名')),
                      h('div', { className: 'analysis-inline' },
                        h(StudioButton, { small: true, disabled: busy.startsWith('docker-'), onClick: () => void dockerAction('status') }, '检查容器'),
                        h(StudioButton, { small: true, disabled: busy.startsWith('docker-'), onClick: () => void dockerAction('start') }, '启动容器'),
                        h(StudioButton, { small: true, disabled: busy.startsWith('docker-'), onClick: () => void dockerAction('stop') }, '停止容器')),
                      h(StudioField, { label: '认证 Cookie' }, h(StudioInput, {
                        value: config.analysisAuthCookie ?? '', onChange: (value) => setConfig((prev) => ({ ...prev, analysisAuthCookie: value })),
                        placeholder: '仅 ADMIN_AUTH_ENABLED 时需要',
                      })),
                      h('div', { className: 'analysis-inline' },
                        h(StudioButton, { small: true, onClick: () => void writeConfig('analysisAuthCookie', config.analysisAuthCookie) }, '保存 Cookie')),
                      h('div', { className: 'analysis-hintcard' },
                        h('strong', null, 'DSA Docker 侧车'),
                        h('p', null, `先启动 ${config.analysisContainer || 'daily_stock_analysis'}，再打开 DSA 工作台确认数据源和模型。${config.analysisSchedule ? `建议把 DSA 自身的每日 schedule 关闭，由大肥鱼在工作日 ${config.analysisSchedule} 触发。` : '当前未设置每日自动分析时间，只保留手动分析。'}`),
                        h('small', null, '桌宠只调用 http://127.0.0.1:8000，不保存 DSA 的模型/数据源 Key。')),
                    ))
            : h(React.Fragment, null,
                h('div', { className: 'analysis-summary' },
                  h('div', null, h('strong', null, '今日概览'), h('small', null, '复用养鱼自选股；分析由 DSA 完成')),
                  h('div', { className: 'analysis-counts' },
                    h('span', { className: 'analysis-count buy' }, `买入 ${counts.buy}`),
                    h('span', { className: 'analysis-count watch' }, `观望 ${counts.watch}`),
                    h('span', { className: 'analysis-count sell' }, `卖出 ${counts.sell}`))),
                h('div', { className: 'analysis-inline' },
                  h(StudioInput, { value: single, onChange: setSingle, placeholder: '单只代码：600519 / hk00700 / AAPL' }),
                  h(StudioButton, { small: true, disabled: busy === 'analyze' || !single.trim(), onClick: () => void analyze([single.trim()]) }, '分析单只')),
                h('div', { className: 'analysis-grid' },
                  h('div', { className: 'analysis-list' },
                    h('div', { className: 'analysis-section-head' }, h('strong', null, '自选 / 最新'), h('small', null, `${items.length} 只`)),
                    stocks.error ? h('div', { className: 'analysis-empty' }, stocks.error) : null,
                    items.length === 0 ? h('div', { className: 'analysis-empty' }, '养鱼自选股为空，先在「设置 → 养鱼」添加。') : null,
                    ...items.map((item) => h('button', {
                      key: item.code, type: 'button',
                      className: `analysis-item${selected === item.code ? ' is-active' : ''}`,
                      onClick: () => void openReport(item),
                    },
                    h('span', { className: 'analysis-item-main' },
                      h('strong', null, item.name || item.code), h('small', null, item.code)),
                    h('span', { className: `analysis-chip ${analysisGroup(item)}` }, item.actionLabel || item.advice || '未分析'),
                    h('span', { className: 'analysis-score' }, item.score == null ? '—' : item.score),
                    ))),
                  h('div', { className: 'analysis-detail' },
                    !selectedItem ? h('div', { className: 'analysis-empty' }, '选择左侧股票查看决策仪表盘。')
                      : h(React.Fragment, null,
                          h('div', { className: 'analysis-detail-head' },
                            h('div', null, h('strong', null, selectedItem.name || selectedItem.code), h('small', null, selectedItem.code)),
                            h('span', { className: `analysis-chip ${analysisGroup(selectedItem)}` }, selectedItem.actionLabel || selectedItem.advice || '未分析'),
                            h('span', { className: 'analysis-score big' }, selectedItem.score == null ? '—' : selectedItem.score)),
                          selectedItem.trend ? h('div', { className: 'analysis-kv' }, h('span', null, '趋势'), h('strong', null, selectedItem.trend)) : null,
                          selectedItem.summary ? h('p', { className: 'analysis-text' }, selectedItem.summary) : null,
                          selectedItem.analyzedAt ? h('small', { className: 'analysis-muted' }, `分析于 ${selectedItem.analyzedAt}`) : null,
                          busy === 'report' ? h('div', { className: 'analysis-empty' }, '正在读取报告…') : null,
                          report?.markdown ? h('pre', { className: 'analysis-markdown' }, report.markdown) : null,
                          report?.news?.length ? h('div', { className: 'analysis-news' },
                            h('strong', null, '关联新闻'),
                            ...report.news.slice(0, 5).map((news, index) => h('div', { key: index, className: 'analysis-news-row' },
                              h('strong', null, news.title || news.name || '新闻'), h('small', null, news.summary || news.content || news.source || '')))) : null,
                          !selectedItem.reportId ? h('div', { className: 'analysis-empty' }, '这只还没有分析报告。点上方「分析自选」或「分析单只」。') : null,
                        ))),
                h('div', { className: 'analysis-tasks' },
                  h('strong', null, activeTasks.length ? `分析任务 ${activeTasks.length}` : '分析任务'),
                  activeTasks.length === 0
                    ? h('small', null, status?.lastSummary ? `最近完成 ${status.lastSummary.total} 只` : '当前没有运行中的任务')
                    : h('div', { className: 'analysis-task-list' },
                        ...activeTasks.map((task, index) => h('div', { key: task.id || index, className: 'analysis-task' },
                          h('span', null, task.code || task.id || '任务'),
                          h('small', null, task.message || task.status || ''),
                          h('progress', { max: 100, value: Number(task.progress) || 0 }))))),
                h('small', { className: 'analysis-disclaimer' }, 'AI 生成内容仅供研究，不构成投资建议。分析由 daily_stock_analysis 完成，桌宠只做展示。'),
              ),
    )
  }

  function apply(ctx) {
    clientCtx = ctx
    // Settings intentionally live only in the studio: no DSH settings/plugin
    // configuration cards are registered, so there is one place to edit the
    // pet, weather, countdown and market watchlist.

    // 0.4: the studio is a full-page main panel addressed by this sidebar id.
    // Register both seats together so the left rail and the page always agree.
    try {
      ctx.slots.inject('main', () => {
        try {
          return ctx.slots.register({ name: 'main', key: 'dafeiyu-studio' }, StudioPage)
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) console.error('[dsh-dafeiyu-jinrong] failed to register studio page:', error)
        }
      })
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[dsh-dafeiyu-jinrong] failed to inject studio main slot:', error)
      }
    }
    try {
      ctx.slots.inject('sidebar.panellist', () => {
        try {
          return ctx.slots.register({
            name: 'sidebar.panellist', id: 'dafeiyu-studio', order: 24,
            label: () => '大肥鱼工坊',
          }, StudioIcon)
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) console.error('[dsh-dafeiyu-jinrong] failed to register studio entry:', error)
        }
      })
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[dsh-dafeiyu-jinrong] failed to inject studio sidebar slot:', error)
      }
    }

    // The in-page pet is opt-in; read the local config once at mount. Any
    // failure (endpoint absent, offline host, closed page) just means no pet.
    try {
      fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((config) => {
          if (config && config.webOverlay === true) registerWebOverlay(ctx)
        })
        .catch(() => {})
    } catch {}
  }

  module.exports = {
    name: 'dsh-dafeiyu-jinrong-client',
    inject: ['slots'],
    apply,
  }
  return module.exports
} })
