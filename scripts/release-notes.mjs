import { readFileSync } from 'node:fs'

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const section = changelog.split(/^## /m).find((entry) => entry.split(/\r?\n/)[0].split(' · ')[0] === version)
if (!section) throw new Error(`CHANGELOG.md has no entry for ${version}`)

const releases = 'https://github.com/zhing99-hash/dsh-dafeiyu-jinrong/releases'
const archive = `${name}-${version}.tgz`
const notice = version.includes('-')
  ? '> 这是预览版本。普通用户请安装[最新稳定版](' + releases + '/latest)。\n> This is a prerelease. For normal use, install the [latest stable version](' + releases + '/latest).'
  : '> 安装请使用[最新稳定版](' + releases + '/latest)；如果本页已成为历史记录，请转到该入口。\n> Use the [latest stable release](' + releases + '/latest) for installation; older pages are historical records.'

process.stdout.write([
  notice,
  '',
  '## 安装 / Install',
  '',
  // This fork is not on npm, so `name@version` would resolve to nothing. The
  // only supported path is the .tgz attached to this release.
  `1. 下载本页 Assets 里的 \`${archive}\`（不用解压）。`,
  `   Download \`${archive}\` from the Assets below (do not unpack it).`,
  '2. 完全退出对应 DSH Host，然后按路径安装：',
  '   Quit the target DSH Host, then install by path:',
  '',
  '```powershell',
  `dsh plugin --profile web add "C:\\Users\\<you>\\Downloads\\${archive}"`,
  '```',
  '',
  '- 官方桌面端用应用自带的 `dsh`（安装目录 `resources/runtime/cli/bin/dsh.cmd`）。',
  '- Official Desktop: use the bundled `dsh` under the app install directory.',
  '- 本 fork **不发布到 npm**，所以 `包名@版本` 这种写法装不了；也能用仓库里的 `pnpm pack` 自己打包。',
  '- This fork is **not published to npm**, so `name@version` will not resolve; `pnpm pack` from the repo works too.',
  '- Windows、Linux 和 macOS 共用一个包；GitHub 的 Source code (zip / tar.gz) 不是安装包。',
  '- One package supports Windows, Linux, and macOS; GitHub Source code archives are not installable packages.',
  '',
  '## 本版变更 / Changes',
  '',
  section.replace(/^[^\r\n]+\r?\n/, '').trim(),
  '',
].join('\n'))
