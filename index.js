/**
 * dsh-everything-file: whole-disk `@file` completion for the DeepSeek Harness
 * Web GUI, backed by its own NTFS index service.
 *
 * The shipped provider (`@deepseek-ai/dsh-file-reference-local`) walks the
 * session workspace on every index rebuild. This provider implements the same
 * `ctx.fileReferences` seam, but answers from an in-memory NTFS index: the
 * bundled `dsh-mft-index` Windows service reads every fixed volume's MFT
 * (the same machinery Everything uses), keeps lower-cased names in memory, and
 * serves substring queries over a named pipe. The Harness process itself never
 * needs elevation; only the one-time service installation does.
 *
 * An optional Everything backend remains for machines that already run
 * Everything: when `backend: auto` finds the local service unavailable and an
 * Everything client reachable, it uses Everything instead. Once the local
 * service is installed it becomes the preferred backend.
 *
 * The browser `@` completion, its path grammar, and the Session Controller
 * Remote are unchanged. Picking a result still inserts ordinary prompt text;
 * file contents are read by the model's `read` tool.
 *
 * @module dsh-everything-file
 */

import z from '@deepseek-ai/schemastery'
import { FileReferenceService, FILE_REFERENCE_PROMPT } from '@deepseek-ai/dsh-file-reference'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { EverythingEngine } from './lib/engine.js'
import { MftIndexEngine } from './lib/mft-engine.js'
import { SpotlightEngine } from './lib/spotlight-engine.js'
import { LocalIndexEngine } from './lib/local-index-engine.js'
import { searchCandidates } from './lib/search.js'

/** Local NTFS index service name and pipe, matching the bundled installer. */
const DEFAULT_SERVICE_PIPE = 'dsh-mft-index'

/**
 * Whole-disk file-reference provider. The backend is chosen per platform:
 * Windows prefers the bundled MFT service, macOS prefers Spotlight, and every
 * platform can fall back to the portable walk index that needs no elevation or
 * external software.
 */
export default class EverythingFileReferenceService extends FileReferenceService {
  /** Services required before the provider mounts. */
  static inject = ['agents', 'workingDirectory', 'tools']

  /** Deployment-tunable bounds; validated by the Loader before construction. */
  static Config = z.object({
    backend: z.string().default('auto'),
    maxResults: z.number().step(1).min(1).default(20),
    scanLimit: z.number().step(1).min(20).default(300),
    recentOnEmpty: z.boolean().default(true),
    mftPipe: z.string().default(DEFAULT_SERVICE_PIPE),
    mftTimeoutMs: z.number().step(1).min(200).default(2500),
    autoStartEverything: z.boolean().default(false),
    everythingExe: z.string().default(''),
    bridgeTimeoutMs: z.number().step(1).min(200).default(4000),
    localRoots: z.array(z.string()).default([]),
    localExcludeRoots: z.array(z.string()).default([]),
    localMaxEntries: z.number().step(1).min(1000).default(12000000),
    localRefreshMinutes: z.number().step(1).min(0).default(15),
  })

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - host cordis context.
   * @param {object} [config] - validated plugin configuration.
   */
  constructor(ctx, config = {}) {
    super(ctx)
    this.config = EverythingFileReferenceService.Config(config ?? {})

    /** Per-agent prompt fibers, installed while the agent can call `read`. */
    this.promptFibers = new Map()
    /** Last engine failure, so a broken backend logs once, not per keystroke. */
    this.lastReportedError = ''
    /** Backend selection cache: `{ engine, at }`, re-evaluated periodically. */
    this.engineChoice = { engine: undefined, at: 0 }
    /**
     * Plain service references captured at construction. Cordis hands
     * `ctx.fileReferences` callers a proxy, and a method invoked through that
     * proxy cannot touch `this.#private` members (the brand check fails), so
     * `list()` may only read ordinary public properties.
     */
    this.workingDirectory = ctx.workingDirectory
    this.logger = ctx.logger

    this.mft = new MftIndexEngine({
      pipeName: this.config.mftPipe,
      timeoutMs: this.config.mftTimeoutMs,
      logger: { warn: message => ctx.logger.warn(String(message)) },
    })
    this.everything = new EverythingEngine({
      everythingExe: this.config.everythingExe,
      autoStart: this.config.autoStartEverything,
      timeoutMs: this.config.bridgeTimeoutMs,
      logger: { warn: message => ctx.logger.warn(String(message)) },
    })
    this.spotlight = new SpotlightEngine({
      timeoutMs: 5000,
      logger: { warn: message => ctx.logger.warn(String(message)) },
    })
    this.local = new LocalIndexEngine({
      roots: this.config.localRoots,
      excludes: this.config.localExcludeRoots,
      maxEntries: this.config.localMaxEntries,
      refreshMinutes: this.config.localRefreshMinutes,
      logger: { warn: message => ctx.logger.warn(String(message)) },
    })
    ctx.effect(() => () => {
      this.mft.dispose()
      this.everything.dispose()
      this.spotlight.dispose()
      this.local.dispose()
    }, 'dsh-everything-file: index engines')

    // Arrow functions capture the constructor's real `this`, so they keep
    // working when invoked through the Cordis service proxy (which a private
    // method would not).
    this.resolveEngine = async () => {
      const now = Date.now()
      if (this.engineChoice.engine !== undefined && now - this.engineChoice.at < 10000) {
        return this.engineChoice.engine
      }
      const preferred = String(this.config.backend ?? 'auto').toLowerCase()
      let engine
      if (preferred === 'everything') {
        engine = this.everything
      } else if (preferred === 'spotlight') {
        engine = this.spotlight
      } else if (preferred === 'mft') {
        engine = this.mft
      } else if (preferred === 'local') {
        engine = this.local
      } else if (process.platform === 'darwin') {
        // macOS: Spotlight is the system-wide index; walk locally if mdfind is
        // unavailable (e.g. Spotlight indexing disabled).
        const spot = await this.spotlight.status()
        engine = spot.running ? this.spotlight : this.local
      } else if (process.platform === 'win32') {
        const local = await this.mft.status()
        if (local.running) {
          engine = this.mft
        } else {
          const remote = await this.everything.status()
          // An already-running Everything is faster than the first walk-index
          // build; a clean machine gets the portable index.
          engine = remote.running ? this.everything : this.local
        }
      } else {
        // Linux and other platforms: portable walk index, no external setup.
        engine = this.local
      }
      this.engineChoice = { engine, at: now }
      return engine
    }
    this.invalidateEngineChoice = () => {
      this.engineChoice = { engine: undefined, at: 0 }
    }

    // If this deployment explicitly uses Everything, start its client once at
    // activation, off the keystroke path. The local service needs no warm-up.
    if (String(this.config.backend).toLowerCase() === 'everything') {
      ctx.effect(() => {
        const timer = setTimeout(() => {
          void this.everything.warm()
        }, 1200)
        return () => clearTimeout(timer)
      }, 'dsh-everything-file: Everything warm start')
    }

    this.#installPrompts(ctx)
    this.#registerSearchTool(ctx)
    this.#registerStatusTool(ctx)
  }

  /**
   * Answer one `@file` completion request from the active index backend.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent - the addressed agent.
   * @param {string} query - path text following `@` or `@"`.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<Array<{ path: string, kind: 'file' | 'directory' }>>}
   */
  async list(agent, query, signal) {
    let cwd
    try {
      cwd = await this.workingDirectory.ensure(agent, signal)
    } catch {
      cwd = undefined
    }
    const engine = await this.resolveEngine()
    const result = await searchCandidates({
      engine,
      cwd,
      query,
      limit: this.config.maxResults,
      scanLimit: this.config.scanLimit,
      signal,
      recentOnEmpty: this.config.recentOnEmpty,
      indexWaitMs: 400,
      timeoutMs: engine.kind === 'mft' ? this.config.mftTimeoutMs : engine.kind === 'spotlight' ? 5000 : 5000,
    })
    if (result.error !== undefined) {
      this.invalidateEngineChoice()
      const key = `${result.error.code}:${result.error.message}`
      if (key !== this.lastReportedError) {
        this.lastReportedError = key
        this.logger.warn(`dsh-everything-file: ${describeError(result.error, this.config, engine.kind)}`)
      }
    } else {
      this.lastReportedError = ''
    }
    return result.candidates
  }

  /**
   * Install the stable file-reference guidance for each agent that can call
   * `read`, exactly as the shipped provider does.
   * @param {import('@deepseek-ai/cordis').Context} ctx
   */
  #installPrompts(ctx) {
    const install = agent => {
      const existing = this.promptFibers.get(agent)
      if (existing !== undefined) return existing
      const fiber = agent.ctx.inject(['systemPrompt', 'tools'], scope => {
        scope.systemPrompt.section({
          name: 'context:file-reference',
          order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
          text: () => (agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT),
        })
      })
      this.promptFibers.set(agent, fiber)
      return fiber
    }

    for (const agent of ctx.agents.list()) install(agent)
    ctx.on('agent/created', ({ agent }) => {
      install(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const fiber = this.promptFibers.get(agent)
      if (fiber === undefined) return
      this.promptFibers.delete(agent)
      Promise.resolve(fiber.dispose()).catch(error => {
        ctx.logger.warn(`dsh-everything-file: prompt cleanup failed: ${String(error)}`)
      })
    })
    ctx.effect(() => async () => {
      const fibers = [...this.promptFibers.values()]
      this.promptFibers.clear()
      await Promise.all(fibers.map(fiber => Promise.resolve(fiber.dispose())))
    }, 'dsh-everything-file: prompt sections')
  }

  /**
   * Register the model-facing whole-disk search tool over the active backend.
   * @param {import('@deepseek-ai/cordis').Context} ctx
   */
  #registerSearchTool(ctx) {
    const service = this
    const tool = defineTool({
      name: 'everything_search',
      description: [
        'Search every local disk by file or folder name/path through the local NTFS index.',
        'Use it to locate files outside the current workspace; it is far faster than globbing a drive.',
        'Whitespace-separated terms are ANDed and match names; a term containing / or \\ matches the full path;',
        'ext:pdf and *.pdf filter by extension; wildcards * and ? are accepted.',
        'Returns absolute paths, one per line; a trailing / marks a directory.',
        'An empty query returns recently modified files across all indexed disks.',
      ].join(' '),
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Search text, e.g. "report", "*.psd", "ext:pdf", "D:/Projects config", "src\\view".',
        },
        limit: {
          type: 'number',
          description: 'Maximum paths to return (1-500). Defaults to 50.',
        },
      },
      timeoutMs: 15000,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const limit = clampLimit(args.limit)
        let cwd
        try {
          if (exec.agent !== undefined) cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        } catch {
          cwd = undefined
        }
        const engine = await service.resolveEngine()
        const result = await searchCandidates({
          engine,
          cwd,
          query,
          limit,
          scanLimit: Math.max(service.config.scanLimit, limit * 2),
          signal: exec.signal,
          recentOnEmpty: service.config.recentOnEmpty,
          indexWaitMs: engine.kind === 'mft' ? 0 : 8000,
          timeoutMs: engine.kind === 'mft' ? service.config.mftTimeoutMs : 8000,
        })
        if (result.error !== undefined) {
          service.invalidateEngineChoice()
          throw new Error(describeError(result.error, service.config, engine.kind))
        }
        if (result.candidates.length === 0) {
          return query === '' ? 'No recently modified files were found.' : `No files or folders matched: ${query}`
        }
        const lines = result.candidates.map(candidate => `${candidate.path}${candidate.kind === 'directory' ? '/' : ''}`)
        const scope = result.scope === 'directory' ? 'in the listed folder' : result.scope === 'recent' ? 'recently modified' : 'matching'
        return `${lines.length} path(s) ${scope}:\n${lines.join('\n')}`
      },
    })
    ctx.effect(() => ctx.tools.register(tool), 'dsh-everything-file: search tool')
  }

  /**
   * Register a small diagnostic tool: backend choice, index readiness and the
   * installer location. The installer itself must run elevated, so the plugin
   * can only point at it.
   * @param {import('@deepseek-ai/cordis').Context} ctx
   */
  #registerStatusTool(ctx) {
    const service = this
    const tool = defineTool({
      name: 'mft_index_status',
      description: 'Report the active file-index backend, its build progress, and how to install the optional fast paths.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        const isMac = process.platform === 'darwin'
        const isWindows = process.platform === 'win32'
        const [local, everything, spotlight] = isWindows
          ? await Promise.all([
            service.mft.status(),
            service.everything.status(),
            service.spotlight.status(),
          ])
          : [undefined, undefined, await service.spotlight.status()]
        const engine = await service.resolveEngine()
        const walk = engine.kind === 'local' ? await service.local.status() : service.local.peekStatus()
        const lines = []
        lines.push(`platform: ${process.platform}`)
        lines.push(`backend config: ${service.config.backend}`)
        lines.push(`active backend: ${engine.kind}`)
        if (isMac) {
          lines.push(`Spotlight: ${spotlight.running ? 'mdfind available' : 'mdfind missing or Spotlight disabled'}`)
          lines.push('macOS uses the system Spotlight index; no service installation is needed.')
        }
        if (isWindows) {
          lines.push(`MFT service pipe: ${service.config.mftPipe}`)
          lines.push(local.running
            ? `MFT service: ready=${local.ready === true} entries=${local.entries ?? 0} building=${local.building === true} buildMs=${local.buildMs ?? 0}`
            : `MFT service: not running (${local.error ? local.error.message : 'unavailable'})`)
          lines.push(`Everything: ${everything.running ? 'client reachable' : 'not running'}`)
        }
        if (walk.running) {
          lines.push(`portable walk index: ready=${walk.ready === true} building=${walk.building === true} entries=${walk.entries ?? 0} buildMs=${walk.buildMs ?? 0}`)
          if (Array.isArray(walk.roots) && walk.roots.length > 0) lines.push(`  roots: ${walk.roots.join(', ')}`)
          if (walk.truncated === true) lines.push('  note: the entry cap was reached; raise localMaxEntries to index more')
        } else if (engine.kind === 'local') {
          lines.push('portable walk index: starting')
        } else {
          lines.push('portable walk index: idle (starts automatically if no fast backend is available)')
        }
        if (isWindows && !local.running) {
          lines.push('')
          lines.push('The MFT service is optional. Without it the plugin uses the portable walk index,')
          lines.push('which needs no administrator rights but builds more slowly on the first run.')
          lines.push('For the fastest full-disk index, install the service once from an elevated prompt:')
          lines.push('  dsh-everything-file\\scripts\\install-service.cmd')
        }
        return lines.join('\n')
      },
    })
    ctx.effect(() => ctx.tools.register(tool), 'dsh-everything-file: index status tool')
  }
}

/**
 * Turn an engine error into an actionable message for logs and tools.
 * @param {{ code: number, message: string }} error
 * @param {{ backend: string }} config
 * @param {string} [engineKind]
 * @returns {string}
 */
function describeError(error, config, engineKind) {
  if (engineKind === 'spotlight') {
    return `Spotlight search failed: ${error.message}; check that Spotlight indexing is enabled (mdutil -s /) and that /usr/bin/mdfind exists`
  }
  if (engineKind === 'local') {
    return `portable index search failed: ${error.message}; the first full-disk build can take a few minutes and retries automatically`
  }
  if (error.code === 2 || /pipe|connect|not running/i.test(error.message)) {
    return `local index service unavailable (${error.message}); install it with dsh-everything-file\\scripts\\install-service.cmd, or set backend: everything to use an existing Everything client`
  }
  return `index search failed: ${error.message}`
}

/**
 * Clamp the tool's `limit` argument.
 * @param {unknown} value
 * @returns {number}
 */
function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50
  return Math.min(500, Math.max(1, Math.trunc(value)))
}
