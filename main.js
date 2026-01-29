'use strict';

const utils = require('@iobroker/adapter-core');
const {
	parseExpression,
	normalizeFormulaExpression: normalizeFormulaExpressionImpl,
	analyzeAst: analyzeAstImpl,
	evalFormulaAst: evalFormulaAstImpl,
} = require('./lib/formula');
const {
	applyJsonPath: applyJsonPathImpl,
	getNumericFromJsonPath: getNumericFromJsonPathImpl,
	getValueFromJsonPath: getValueFromJsonPathImpl,
} = require('./lib/jsonpath');

class DataSolectrus extends utils.Adapter {
	constructor(options) {
		super({
			...options,
			name: 'data-solectrus',
		});

		// Hard limits to keep formula evaluation predictable even with hostile/mistyped configs.
		this.MAX_FORMULA_LENGTH = 8000;
		this.MAX_AST_NODES = 2000;
		this.MAX_AST_DEPTH = 60;
		this.MAX_DISCOVERED_STATE_IDS_PER_ITEM = 250;
		// Global caps to keep runtime behavior predictable even with huge configs.
		this.MAX_TOTAL_SOURCE_IDS = 5000;
		this.TICK_TIME_BUDGET_RATIO = 0.8;

		this.cache = new Map();
		this.cacheTs = new Map();
		// Precompiled per-item cache to keep tick evaluation fast and robust.
		/** @type {Map<string, {ok:boolean, error?:string, item:any, outputId:string, mode:string, sourceIds:Set<string>, normalizedExpr?:string, ast?:any, constantValue?:any}>} */
		this.compiledItems = new Map();
		this.itemsConfigSignature = '';
		this.subscribedIds = new Set();
		this.lastGoodValue = new Map();
		this.lastGoodTs = new Map();
		this.consecutiveErrorCounts = new Map();

		this.currentSnapshot = null;
		this.tickTimer = null;
		this.isUnloading = false;
		this.jsonPathWarned = new Set();
		this.debugOnceKeys = new Set();

		this.formulaFunctions = {
			min: Math.min,
			max: Math.max,
			pow: Math.pow,
			abs: Math.abs,
			round: Math.round,
			floor: Math.floor,
			ceil: Math.ceil,
			// IF(condition, valueIfTrue, valueIfFalse)
			IF: (condition, valueIfTrue, valueIfFalse) => (condition ? valueIfTrue : valueIfFalse),
			if: (condition, valueIfTrue, valueIfFalse) => (condition ? valueIfTrue : valueIfFalse),
			clamp: (value, min, max) => {
				const v = Number(value);
				const lo = Number(min);
				const hi = Number(max);
				if (!Number.isFinite(v)) return 0;
				if (Number.isFinite(lo) && v < lo) return lo;
				if (Number.isFinite(hi) && v > hi) return hi;
				return v;
			},
			// Read a foreign state value by id from cache/snapshot (raw, but restricted to primitives).
			// This keeps formulas deterministic and avoids accidentally dragging large objects into evaluation.
			v: id => {
				const key = String(id);
				const val = (this.currentSnapshot && typeof this.currentSnapshot.get === 'function')
					? this.currentSnapshot.get(key)
					: this.cache.get(key);
				if (val === null || val === undefined) return val;
				const t = typeof val;
				if (t === 'string' || t === 'number' || t === 'boolean') return val;
				// Best-effort for Date-like values; everything else becomes empty string.
				if (val instanceof Date && typeof val.toISOString === 'function') return val.toISOString();
				this.debugOnce(`v_non_primitive|${key}`, `v("${key}") returned non-primitive (${t}); treating as empty string`);
				return '';
			},
			// Extract a primitive value from a JSON payload using the adapter's minimal JSONPath subset.
			// Example: jp('mqtt.0.espaltherma.ATTR', "$['Operation Mode']")
			jp: (id, jsonPath) => {
				const key = String(id);
				const raw = (this.currentSnapshot && typeof this.currentSnapshot.get === 'function')
					? this.currentSnapshot.get(key)
					: this.cache.get(key);
				const jp = jsonPath !== undefined && jsonPath !== null ? String(jsonPath).trim() : '';
				if (!jp) return undefined;

				let obj = null;
				if (raw && typeof raw === 'object') {
					obj = raw;
				} else if (typeof raw === 'string') {
					const s = raw.trim();
					if (!s) return undefined;
					try {
						obj = JSON.parse(s);
					} catch (e) {
						this.debugOnce(
							`jp_parse_failed|${key}|${jp}`,
							`jp("${key}", "${jp}") cannot parse JSON: ${e && e.message ? e.message : e}`
						);
						return undefined;
					}
				} else {
					return undefined;
				}

				const extracted = this.applyJsonPath(obj, jp);
				if (extracted === undefined || extracted === null) return extracted;
				const t = typeof extracted;
				if (t === 'string' || t === 'number' || t === 'boolean') return extracted;
				if (extracted instanceof Date && typeof extracted.toISOString === 'function') return extracted.toISOString();
				return undefined;
			},
			// Read a foreign state value by id from cache (sync, safe).
			s: id => {
				const key = String(id);
				if (this.currentSnapshot && typeof this.currentSnapshot.get === 'function') {
					return this.safeNum(this.currentSnapshot.get(key));
				}
				return this.safeNum(this.cache.get(key));
			},
		};

		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
	}

	getErrorRetriesBeforeZero() {
		const raw = this.config && this.config.errorRetriesBeforeZero !== undefined ? this.config.errorRetriesBeforeZero : 3;
		const n = Number(raw);
		// Keep it sane even if not in Admin schema yet.
		if (!Number.isFinite(n) || n < 0) return 3;
		return Math.min(100, Math.round(n));
	}

	getItemsConfigSignature(items) {
		const arr = Array.isArray(items) ? items : [];
		// Only include relevant fields; order is stable by array order.
		const normalized = arr
			.filter(it => it && typeof it === 'object')
			.map(it => ({
				enabled: !!it.enabled,
				mode: it.mode || 'formula',
				group: it.group || '',
				targetId: it.targetId || '',
				name: it.name || '',
				type: it.type || '',
				role: it.role || '',
				unit: it.unit || '',
				noNegative: !!it.noNegative,
				clamp: !!it.clamp,
				min: it.min,
				max: it.max,
				sourceState: it.sourceState || '',
				jsonPath: it.jsonPath || '',
				formula: it.formula || '',
				inputs: Array.isArray(it.inputs)
					? it.inputs
						.filter(inp => inp && typeof inp === 'object')
						.map(inp => ({
							key: inp.key || '',
							sourceState: inp.sourceState || '',
							jsonPath: inp.jsonPath || '',
							noNegative: !!inp.noNegative,
						}))
					: [],
			}));
		try {
			return JSON.stringify(normalized);
		} catch {
			// Fallback: should never happen for plain objects
			return String(Date.now());
		}
	}

	compileItem(item) {
		const mode = item && item.mode ? String(item.mode) : 'formula';
		const outputId = this.getItemOutputId(item);
		const sourceIds = new Set(this.collectSourceStatesFromItem(item));

		if (!outputId) {
			return { ok: false, error: 'Missing/invalid targetId', item, outputId: '', mode, sourceIds };
		}

		if (mode === 'source') {
			return { ok: true, item, outputId, mode, sourceIds };
		}

		const exprRaw = item && item.formula !== undefined && item.formula !== null ? String(item.formula).trim() : '';
		if (!exprRaw) {
			// Treat empty formula as constant 0.
			return { ok: true, item, outputId, mode, sourceIds, normalizedExpr: '', ast: null, constantValue: 0 };
		}

		const normalized = this.normalizeFormulaExpression(exprRaw);
		if (normalized && normalized.length > this.MAX_FORMULA_LENGTH) {
			return {
				ok: false,
				error: `Formula too long (>${this.MAX_FORMULA_LENGTH} chars)`,
				item,
				outputId,
				mode,
				sourceIds,
				normalizedExpr: normalized,
			};
		}

		try {
			const ast = parseExpression(String(normalized));
			this.analyzeAst(ast);
			return { ok: true, item, outputId, mode, sourceIds, normalizedExpr: normalized, ast };
		} catch (e) {
			return {
				ok: false,
				error: e && e.message ? e.message : String(e),
				item,
				outputId,
				mode,
				sourceIds,
				normalizedExpr: normalized,
			};
		}
	}

	ensureCompiledForCurrentConfig(items) {
		const sig = this.getItemsConfigSignature(items);
		if (sig !== this.itemsConfigSignature) {
			return this.prepareItems();
		}
		return Promise.resolve();
	}

	getItemInfoBaseId(outputId) {
		return `items.${String(outputId)}`;
	}

	async ensureItemInfoStatesForCompiled(compiled) {
		if (!compiled || !compiled.outputId) return;
		const base = this.getItemInfoBaseId(compiled.outputId);

		await this.ensureChannelPath(`${base}.compiledOk`);

		await this.setObjectNotExistsAsync(`${base}.compiledOk`, {
			type: 'state',
			common: {
				name: 'Compiled OK',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync(`${base}.compileError`, {
			type: 'state',
			common: {
				name: 'Compile Error',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync(`${base}.lastError`, {
			type: 'state',
			common: {
				name: 'Last Error',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync(`${base}.lastOkTs`, {
			type: 'state',
			common: {
				name: 'Last OK Timestamp',
				type: 'string',
				role: 'date',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync(`${base}.lastEvalMs`, {
			type: 'state',
			common: {
				name: 'Last Evaluation Time (ms)',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
				unit: 'ms',
			},
			native: {},
		});

		await this.setObjectNotExistsAsync(`${base}.consecutiveErrors`, {
			type: 'state',
			common: {
				name: 'Consecutive Errors',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
			},
			native: {},
		});
	}

	safeNum(val, fallback = 0) {
		const n = Number(val);
		return Number.isFinite(n) ? n : fallback;
	}

	warnOnce(key, msg) {
		const k = String(key);
		if (this.jsonPathWarned.size > 500) this.jsonPathWarned.clear();
		if (this.jsonPathWarned.has(k)) return;
		this.jsonPathWarned.add(k);
		this.log.warn(msg);
	}

	debugOnce(key, msg) {
		const k = String(key);
		if (this.debugOnceKeys.size > 500) this.debugOnceKeys.clear();
		if (this.debugOnceKeys.has(k)) return;
		this.debugOnceKeys.add(k);
		this.log.debug(msg);
	}

	/**
	 * Minimal JSONPath subset evaluator for typical IoT payloads.
	 * Supported examples:
	 * - $.apower
	 * - $.aenergy.by_minute[2]
	 * - $['temperature']['tC']
	 *
	 * Not supported: filters, wildcards, unions, recursive descent, functions.
	 */
	applyJsonPath(obj, path) {
		return applyJsonPathImpl(obj, path);
	}

	analyzeAst(ast) {
		return analyzeAstImpl(ast, { maxNodes: this.MAX_AST_NODES, maxDepth: this.MAX_AST_DEPTH });
	}

	getNumericFromJsonPath(rawValue, jsonPath, warnKeyPrefix = '') {
		return getNumericFromJsonPathImpl(rawValue, jsonPath, {
			safeNum: this.safeNum.bind(this),
			warnOnce: this.warnOnce.bind(this),
			debugOnce: this.debugOnce.bind(this),
			warnKeyPrefix,
		});
	}

	getValueFromJsonPath(rawValue, jsonPath, warnKeyPrefix = '') {
		return getValueFromJsonPathImpl(rawValue, jsonPath, {
			warnOnce: this.warnOnce.bind(this),
			warnKeyPrefix,
		});
	}

	/**
	 * Normalizes some common non-JS formula syntax into the JS-like operators that `jsep` understands.
	 * - AND/OR/NOT (case-insensitive) -> && / || / !
	 * - single '=' (outside strings) -> '=='
	 *
	 * This is intentionally conservative and only runs outside quoted strings.
	 */
	normalizeFormulaExpression(expr) {
		return normalizeFormulaExpressionImpl(expr);
	}

	evalFormula(expr, vars) {
		const normalized = this.normalizeFormulaExpression(expr);
		if (normalized && normalized.length > this.MAX_FORMULA_LENGTH) {
			throw new Error(`Formula too long (>${this.MAX_FORMULA_LENGTH} chars)`);
		}
		const ast = parseExpression(String(normalized));
		this.analyzeAst(ast);
		return this.evalFormulaAst(ast, vars);
	}

	evalFormulaAst(ast, vars) {
		return evalFormulaAstImpl(ast, vars, this.formulaFunctions);
	}

	getTickIntervalMs() {
		const fallbackSeconds = 5;
		const cfgSecondsRaw = this.config && this.config.pollIntervalSeconds !== undefined ? this.config.pollIntervalSeconds : fallbackSeconds;
		const cfgSeconds = Number(cfgSecondsRaw);

		// Keep it sane; Admin enforces min/max but we also guard here.
		const seconds = Number.isFinite(cfgSeconds) && cfgSeconds > 0 ? cfgSeconds : fallbackSeconds;
		return Math.round(seconds * 1000);
	}

	calcTitle(item) {
		const enabled = !!(item && item.enabled);
		const displayId = this.getItemDisplayId(item);
		const name = (item && item.name) ? String(item.name) : (displayId || 'Item');
		return `${enabled ? '🟢 ' : '⚪ '}${name}`;
	}

	getItemDisplayId(item) {
		const group = item && item.group ? String(item.group).trim() : '';
		const targetId = item && item.targetId ? String(item.targetId).trim() : '';
		if (group && targetId) return `${group}.${targetId}`;
		return targetId || group;
	}

	ensureTitle(item) {
		return { ...(item || {}), _title: this.calcTitle(item || {}) };
	}

	async ensureItemTitlesInInstanceConfig() {
		try {
			const objId = `system.adapter.${this.namespace}`;
			const obj = await this.getForeignObjectAsync(objId);
			if (!obj || !obj.native) {
				return;
			}

			const items = Array.isArray(obj.native.items) ? obj.native.items : [];
			const itemsEditor = Array.isArray(obj.native.itemsEditor) ? obj.native.itemsEditor : [];
			const active = items.length ? items : itemsEditor;
			if (!Array.isArray(active)) {
				return;
			}

			let changed = false;
			active.forEach(it => {
				if (!it || typeof it !== 'object') return;
				const expectedTitle = this.calcTitle(it);
				if (it._title !== expectedTitle) {
					it._title = expectedTitle;
					changed = true;
				}
			});

			// If Admin stored items under `itemsEditor`, migrate them back into `items`
			// so the runtime + fallback table see the same config.
			if (items.length === 0 && itemsEditor.length > 0) {
				obj.native.items = itemsEditor;
				changed = true;
			}

			if (changed) {
				await this.setForeignObjectAsync(objId, obj);
			}
		} catch (e) {
			this.log.debug(`Cannot migrate item titles: ${e}`);
		}
	}

	async createInfoStates() {
		await this.setObjectNotExistsAsync('info.status', {
			type: 'state',
			common: {
				name: 'Status',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.itemsConfigured', {
			type: 'state',
			common: {
				name: 'Configured items',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.itemsEnabled', {
			type: 'state',
			common: {
				name: 'Enabled items',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.lastError', {
			type: 'state',
			common: {
				name: 'Last Error',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.lastRun', {
			type: 'state',
			common: {
				name: 'Last Run',
				type: 'string',
				role: 'date',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.evalTimeMs', {
			type: 'state',
			common: {
				name: 'Evaluation time (ms)',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.timeBudgetMs', {
			type: 'state',
			common: {
				name: 'Tick time budget (ms)',
				type: 'number',
				role: 'value',
				unit: 'ms',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.skippedItems', {
			type: 'state',
			common: {
				name: 'Skipped items (last tick)',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setStateAsync('info.status', 'starting', true);
		await this.setStateAsync('info.itemsConfigured', 0, true);
		await this.setStateAsync('info.itemsEnabled', 0, true);
		await this.setStateAsync('info.lastError', '', true);
		await this.setStateAsync('info.lastRun', '', true);
		await this.setStateAsync('info.evalTimeMs', 0, true);
		await this.setStateAsync('info.timeBudgetMs', 0, true);
		await this.setStateAsync('info.skippedItems', 0, true);
	}

	getTickTimeBudgetMs() {
		const interval = this.getTickIntervalMs();
		const ratioRaw = Number(this.TICK_TIME_BUDGET_RATIO);
		const ratio = Number.isFinite(ratioRaw) && ratioRaw > 0 && ratioRaw <= 1 ? ratioRaw : 0.8;
		return Math.max(0, Math.floor(interval * ratio));
	}

	getMaxTotalSourceIds() {
		const raw = Number(this.MAX_TOTAL_SOURCE_IDS);
		if (!Number.isFinite(raw) || raw <= 0) return 5000;
		return Math.min(50000, Math.round(raw));
	}

	isNumericOutputItem(item) {
		const t = item && item.type ? String(item.type) : '';
		// Only these should be forced numeric and get clamping/noNegative rules.
		return t === '' || t === 'number';
	}

	getZeroValueForItem(item) {
		const t = item && item.type ? String(item.type) : '';
		if (t === 'string') return '';
		if (t === 'boolean') return false;
		// number/mixed (and default)
		return 0;
	}

	getDesiredSourceIdsForItems(items) {
		const enabledItems = Array.isArray(items)
			? items.filter(it => it && typeof it === 'object' && it.enabled)
			: [];

		const desired = new Set();
		for (const item of enabledItems) {
			const out = this.getItemOutputId(item);
			const compiled = out ? this.compiledItems.get(out) : null;
			if (compiled && compiled.sourceIds) {
				for (const id of compiled.sourceIds) {
					if (id) desired.add(String(id));
				}
			} else {
				for (const id of this.collectSourceStatesFromItem(item)) {
					if (id) desired.add(String(id));
				}
			}
		}

		const cap = this.getMaxTotalSourceIds();
		if (desired.size > cap) {
			const kept = new Set();
			let n = 0;
			for (const id of desired) {
				kept.add(id);
				n++;
				if (n >= cap) break;
			}
			this.warnOnce(
				`source_ids_cap|${cap}`,
				`Too many source state ids (${desired.size}); limiting subscriptions/snapshot to first ${cap}. Please reduce configured items/inputs.`
			);
			return kept;
		}
		return desired;
	}

	syncSubscriptions(desiredIds) {
		const desired = desiredIds instanceof Set ? desiredIds : new Set();

		// Unsubscribe stale ids
		for (const id of Array.from(this.subscribedIds)) {
			if (!desired.has(id)) {
				try {
					this.unsubscribeForeignStates(id);
				} catch (e) {
					this.log.debug(`Cannot unsubscribe ${id}: ${e && e.message ? e.message : e}`);
				} finally {
					this.subscribedIds.delete(id);
				}
			}
		}

		// Subscribe missing ids
		for (const id of desired) {
			if (this.subscribedIds.has(id)) continue;
			try {
				this.subscribeForeignStates(id);
				this.subscribedIds.add(id);
			} catch (e) {
				this.log.warn(`Cannot subscribe ${id}: ${e && e.message ? e.message : e}`);
			}
		}
	}

	async onReady() {
		this.isUnloading = false;
		await this.createInfoStates();

		// Config compatibility: some Admin/jsonConfig schema versions may store custom-control data
		// under the control name (e.g. itemsEditor). Always prefer native.items but fall back.
		const items = Array.isArray(this.config.items) ? this.config.items : [];
		const itemsEditor = Array.isArray(this.config.itemsEditor) ? this.config.itemsEditor : [];
		this.config.items = items.length ? items : itemsEditor;

		await this.ensureItemTitlesInInstanceConfig();
		await this.prepareItems();

		this.log.info('Adapter started successfully');
		this.scheduleNextTick();
	}

	onStateChange(id, state) {
		if (!state) return;
		if (id && String(id).startsWith(`${this.namespace}.`)) {
			return;
		}
		this.cache.set(id, state.val);
		this.cacheTs.set(id, typeof state.ts === 'number' ? state.ts : Date.now());
	}

	getUseSnapshotReads() {
		return !!(this.config && this.config.snapshotInputs);
	}

	getSnapshotDelayMs() {
		const raw = this.config && this.config.snapshotDelayMs !== undefined ? this.config.snapshotDelayMs : 0;
		const ms = Number(raw);
		return Number.isFinite(ms) && ms >= 0 && ms <= 5000 ? Math.round(ms) : 0;
	}

	async buildSnapshotForTick(items) {
		const sourceIds = this.getDesiredSourceIdsForItems(items);

		if (this.getUseSnapshotReads()) {
			const delay = this.getSnapshotDelayMs();
			if (delay) {
				await new Promise(resolve => setTimeout(resolve, delay));
			}
			await Promise.all(
				Array.from(sourceIds).map(async id => {
					try {
						const st = await this.getForeignStateAsync(id);
						if (st) {
							this.cache.set(id, st.val);
							this.cacheTs.set(id, typeof st.ts === 'number' ? st.ts : Date.now());
						}
					} catch {
						// ignore per-id read errors
					}
				})
			);
		}

		/** @type {Map<string, any>} */
		const snapshot = new Map();
		for (const id of sourceIds) {
			snapshot.set(id, this.cache.get(id));
		}
		return snapshot;
	}

	collectSourceStatesFromItem(item) {
		const ids = [];
		if (!item || typeof item !== 'object') return ids;

		if ((item.mode || 'formula') === 'source') {
			if (item.sourceState) ids.push(String(item.sourceState));
		} else {
			if (Array.isArray(item.inputs)) {
				for (const inp of item.inputs) {
					if (inp && inp.sourceState) ids.push(String(inp.sourceState));
				}
			}
			// Also allow s("...") / v("...") / jp("...", "...") in formula; discover these ids so snapshot/subscriptions can include them.
			const expr = item.formula ? String(item.formula) : '';
			if (expr) {
				const max = this.MAX_DISCOVERED_STATE_IDS_PER_ITEM;
				let added = 0;
				const re = /\b(?:s|v)\(\s*(['"])([^'"\n\r]+)\1\s*\)/g;
				const reJp = /\bjp\(\s*(['"])([^'"\n\r]+)\1\s*,/g;
				let m;
				while ((m = re.exec(expr)) !== null) {
					const sid = (m[2] || '').trim();
					if (!sid) continue;
					ids.push(sid);
					added++;
					if (added >= max) {
						const itemId = this.getItemDisplayId(item) || (item && item.name ? String(item.name) : 'item');
						this.warnOnce(
							`discover_ids_limit|${itemId}`,
							`Formula contains many s()/v() state reads; limiting discovered ids to ${max} for '${itemId}'`
						);
						break;
					}
				}
				if (added < max) {
					while ((m = reJp.exec(expr)) !== null) {
						const sid = (m[2] || '').trim();
						if (!sid) continue;
						ids.push(sid);
						added++;
						if (added >= max) {
							const itemId = this.getItemDisplayId(item) || (item && item.name ? String(item.name) : 'item');
							this.warnOnce(
								`discover_ids_limit|${itemId}`,
								`Formula contains many s()/v()/jp() state reads; limiting discovered ids to ${max} for '${itemId}'`
							);
							break;
						}
					}
				}
			}
		}
		return ids;
	}

	isValidRelativeId(id) {
		if (!id) return false;
		const raw = String(id).trim();
		if (!raw) return false;
		// No absolute IDs; must be relative within this adapter
		if (raw.includes('..') || raw.startsWith('.') || raw.endsWith('.')) return false;
		// Keep it conservative: segments of [a-zA-Z0-9_-] separated by dots
		return /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(raw);
	}

	getItemTargetId(item) {
		const raw = item && item.targetId ? String(item.targetId).trim() : '';
		if (!raw) return '';
		return this.isValidRelativeId(raw) ? raw : '';
	}

	getItemGroupId(item) {
		const raw = item && item.group ? String(item.group).trim() : '';
		if (!raw) return '';
		return this.isValidRelativeId(raw) ? raw : '';
	}

	getItemOutputId(item) {
		const group = this.getItemGroupId(item);
		const targetId = this.getItemTargetId(item);
		if (!targetId) return '';
		return group ? `${group}.${targetId}` : targetId;
	}

	async ensureChannelPath(id) {
		const raw = id ? String(id).trim() : '';
		if (!raw) return;
		const parts = raw.split('.').filter(Boolean);
		if (parts.length <= 1) return;

		let prefix = '';
		for (let i = 0; i < parts.length - 1; i++) {
			prefix = prefix ? `${prefix}.${parts[i]}` : parts[i];
			await this.setObjectNotExistsAsync(prefix, {
				type: 'channel',
				common: {
					name: parts[i],
				},
				native: {},
			});
		}
	}

	async ensureOutputState(item) {
		const id = this.getItemOutputId(item);
		if (!id) return;

		await this.ensureChannelPath(id);

		const typeMap = {
			number: 'number',
			boolean: 'boolean',
			string: 'string',
			mixed: 'mixed',
		};
		const commonType = typeMap[item.type] || 'number';

		/** @type {ioBroker.SettableStateObject} */
		const obj = {
			type: 'state',
			common: {
				name: item.name || id,
				type: commonType,
				role: item.role || 'value',
				unit: item.unit || undefined,
				read: true,
				write: false,
			},
			native: {
				mode: item.mode || 'formula',
			},
		};

		const existing = await this.getObjectAsync(id);
		if (!existing) {
			await this.setObjectAsync(id, obj);
		} else {
			await this.extendObjectAsync(id, obj);
		}
	}

	async prepareItems() {
		const items = Array.isArray(this.config.items) ? this.config.items : [];
		const validItems = items.filter(it => it && typeof it === 'object');
		const enabledItems = validItems.filter(it => !!it.enabled);
		this.itemsConfigSignature = this.getItemsConfigSignature(items);

		await this.setStateAsync('info.itemsConfigured', validItems.length, true);
		await this.setStateAsync('info.itemsEnabled', enabledItems.length, true);

		for (const item of validItems) {
			await this.ensureOutputState(item);
		}

		// Compile items once (AST + discovered sourceIds). Errors are stored per item and handled during tick.
		const compiled = new Map();
		for (const item of validItems) {
			const c = this.compileItem(item);
			if (c && c.outputId) {
				compiled.set(c.outputId, c);
			}
		}
		this.compiledItems = compiled;

		// Ensure per-item info states and publish compile status.
		for (const c of this.compiledItems.values()) {
			try {
				await this.ensureItemInfoStatesForCompiled(c);
				const base = this.getItemInfoBaseId(c.outputId);
				await this.setStateAsync(`${base}.compiledOk`, !!c.ok, true);
				await this.setStateAsync(`${base}.compileError`, c.ok ? '' : String(c.error || 'compile failed'), true);
			} catch (e) {
				this.log.debug(`Cannot create/update item info states: ${e && e.message ? e.message : e}`);
			}
		}

		const sourceIds = this.getDesiredSourceIdsForItems(items);
		this.syncSubscriptions(sourceIds);

		for (const id of sourceIds) {
			try {
				const obj = await this.getForeignObjectAsync(id);
				if (!obj) {
					this.log.warn(`Source state not found: ${id}`);
					continue;
				}

				const state = await this.getForeignStateAsync(id);
				if (state) {
					this.cache.set(id, state.val);
				}

			} catch (e) {
				this.log.warn(`Cannot subscribe/read ${id}: ${e && e.message ? e.message : e}`);
			}
		}

		if (enabledItems.length === 0) {
			const msg = 'No item is enabled. Please enable at least one item in the adapter configuration.';
			this.log.warn(msg);
			await this.setStateAsync('info.status', 'no_items_enabled', true);
		} else {
			await this.setStateAsync('info.status', 'ok', true);
		}
	}

	scheduleNextTick() {
		if (this.isUnloading) return;
		const interval = this.getTickIntervalMs();
		const now = Date.now();
		const delay = interval - (now % interval);

		if (this.tickTimer) {
			clearTimeout(this.tickTimer);
			this.tickTimer = null;
		}

		this.tickTimer = setTimeout(() => {
			this.runTick()
				.catch(e => {
					const msg = e && e.message ? e.message : String(e);
					this.log.error(`Tick failed: ${msg}`);
					this.setState('info.lastError', msg, true);
				})
				.finally(() => this.scheduleNextTick());
		}, delay);
	}

	async computeItemValue(item, snapshot) {
		const mode = item.mode || 'formula';
		if (mode === 'source') {
			const id = item.sourceState ? String(item.sourceState) : '';
			const raw = snapshot ? snapshot.get(id) : this.cache.get(id);
			let v = this.getNumericFromJsonPath(raw, item && item.jsonPath, `item|${id}|${item && item.targetId ? item.targetId : ''}`);
			// Apply noNegative already at input/source time as well
			if (item && item.noNegative && v < 0) {
				v = 0;
			}
			return v;
		}

		const inputs = Array.isArray(item.inputs) ? item.inputs : [];
		/** @type {Record<string, any>} */
		const vars = Object.create(null);

		for (const inp of inputs) {
			if (!inp || typeof inp !== 'object') continue;
			const keyRaw = inp.key ? String(inp.key).trim() : '';
			const key = keyRaw.replace(/[^a-zA-Z0-9_]/g, '_');
			if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
				const itemId = this.getItemDisplayId(item) || (item && item.name ? String(item.name) : '');
				this.debugOnce(
					`blocked_input_key|${itemId}|${key}`,
					`Blocked dangerous input key '${keyRaw}' (sanitized to '${key}') for item '${itemId}'`
				);
				continue;
			}
			if (!key) continue;
			const id = inp.sourceState ? String(inp.sourceState) : '';
			const raw = snapshot ? snapshot.get(id) : this.cache.get(id);
			let value;
			const hasJsonPath = inp && inp.jsonPath !== undefined && inp.jsonPath !== null && String(inp.jsonPath).trim() !== '';
			if (hasJsonPath) {
				const extracted = this.getValueFromJsonPath(raw, inp && inp.jsonPath, `input|${id}|${key}`);
				if (typeof extracted === 'string') {
					const n = Number(extracted);
					value = Number.isFinite(n) ? n : extracted;
				} else if (typeof extracted === 'number') {
					value = extracted;
				} else if (typeof extracted === 'boolean') {
					value = extracted;
				} else {
					value = extracted;
				}
			} else {
				// Backwards compatible default: inputs without JSONPath are treated as numeric.
				value = this.safeNum(raw);
			}

			// Clamp negative inputs BEFORE formula evaluation (only if numeric).
			if (typeof value === 'number' && ((item && item.noNegative) || (inp && inp.noNegative)) && value < 0) {
				value = 0;
			}
			vars[key] = value;
		}

		const expr = item.formula ? String(item.formula).trim() : '';
		if (!expr) {
			return 0;
		}
		// Prefer compiled AST if available.
		const targetId = this.getItemOutputId(item);
		const compiled = targetId ? this.compiledItems.get(targetId) : null;
		let result;
		if (compiled && compiled.ok) {
			if (compiled.constantValue !== undefined) {
				result = compiled.constantValue;
			} else if (compiled.ast) {
				result = this.evalFormulaAst(compiled.ast, vars);
			} else {
				result = this.evalFormula(expr, vars);
			}
		} else if (compiled && !compiled.ok) {
			throw new Error(compiled.error || 'Formula compile failed');
		} else {
			result = this.evalFormula(expr, vars);
		}
		return result;
	}

	applyResultRules(item, value) {
		let v = this.safeNum(value);

		const toOptionalNumber = val => {
			if (val === undefined || val === null) return NaN;
			if (typeof val === 'string' && val.trim() === '') return NaN;
			const n = Number(val);
			return Number.isFinite(n) ? n : NaN;
		};

		if (item && item.noNegative && v < 0) {
			v = 0;
		}

		if (item && item.clamp) {
			const min = toOptionalNumber(item.min);
			const max = toOptionalNumber(item.max);
			if (Number.isFinite(min) && v < min) v = min;
			if (Number.isFinite(max) && v > max) v = max;
		}

		return v;
	}

	castValueForItemType(item, value) {
		const t = item && item.type ? String(item.type) : '';
		if (t === 'boolean') {
			// ioBroker boolean states should receive real booleans.
			if (typeof value === 'boolean') return value;
			if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : false;
			if (typeof value === 'string') {
				const s = value.trim().toLowerCase();
				if (s === 'true' || s === 'on' || s === 'yes' || s === '1') return true;
				if (s === 'false' || s === 'off' || s === 'no' || s === '0' || s === '') return false;
				const n = Number(value);
				return Number.isFinite(n) ? n !== 0 : false;
			}
			return false;
		}
		if (t === 'string') {
			// Always write a real string.
			if (value === undefined || value === null) return '';
			return String(value);
		}
		if (t === 'mixed') {
			return value;
		}
		// number (and default)
		return this.safeNum(value);
	}

	async runTick() {
		const start = Date.now();
		const items = Array.isArray(this.config.items) ? this.config.items : [];
		const enabledItems = items.filter(it => it && typeof it === 'object' && it.enabled);
		const retriesBeforeZero = this.getErrorRetriesBeforeZero();
		const timeBudgetMs = this.getTickTimeBudgetMs();
		let skippedItems = 0;

		// If config changed (without restart), rebuild compiled cache + subscriptions.
		try {
			await this.ensureCompiledForCurrentConfig(items);
		} catch (e) {
			const msg = e && e.message ? e.message : String(e);
			this.log.warn(`Prepare items failed: ${msg}`);
			try {
				await this.setStateAsync('info.lastError', msg, true);
			} catch {
				// ignore
			}
		}

		// Keep status in sync even if config changes without a restart
		try {
			await this.setStateAsync('info.itemsConfigured', items.filter(it => it && typeof it === 'object').length, true);
			await this.setStateAsync('info.itemsEnabled', enabledItems.length, true);
			await this.setStateAsync('info.status', enabledItems.length ? 'ok' : 'no_items_enabled', true);
			await this.setStateAsync('info.timeBudgetMs', timeBudgetMs, true);
			await this.setStateAsync('info.skippedItems', 0, true);
		} catch {
			// ignore
		}

		let snapshot = null;
		try {
			snapshot = await this.buildSnapshotForTick(items);
		} catch (e) {
			const msg = e && e.message ? e.message : String(e);
			this.log.warn(`Snapshot build failed: ${msg}`);
			try {
				await this.setStateAsync('info.lastError', msg, true);
			} catch {
				// ignore
			}
			snapshot = new Map();
		}
		this.currentSnapshot = snapshot;

		for (let idx = 0; idx < enabledItems.length; idx++) {
			const item = enabledItems[idx];
			if (timeBudgetMs > 0 && (Date.now() - start) > timeBudgetMs) {
				skippedItems = enabledItems.length - idx;
				this.warnOnce(
					`tick_budget_exceeded|${Math.floor(Date.now() / 60000)}`,
					`Tick time budget exceeded (${timeBudgetMs}ms). Skipping ${skippedItems} remaining item(s) this tick.`
				);
				break;
			}
			const targetId = this.getItemOutputId(item);
			if (!targetId) {
				continue;
			}
			const itemStart = Date.now();
			const itemInfoBase = this.getItemInfoBaseId(targetId);

			try {
				const raw = await this.computeItemValue(item, snapshot);
				const shaped = this.isNumericOutputItem(item) ? this.applyResultRules(item, raw) : raw;
				const value = this.castValueForItemType(item, shaped);
				await this.setStateAsync(targetId, value, true);
				this.lastGoodValue.set(targetId, value);
				this.lastGoodTs.set(targetId, Date.now());
				this.consecutiveErrorCounts.set(targetId, 0);
				// Per-item info states (best-effort; must never break tick)
				try {
					await this.setStateAsync(`${itemInfoBase}.lastOkTs`, new Date().toISOString(), true);
					await this.setStateAsync(`${itemInfoBase}.lastEvalMs`, Date.now() - itemStart, true);
					await this.setStateAsync(`${itemInfoBase}.lastError`, '', true);
					await this.setStateAsync(`${itemInfoBase}.consecutiveErrors`, 0, true);
				} catch {
					// ignore
				}
			} catch (e) {
				const name = item.name || targetId;
				const errMsg = e && e.message ? e.message : String(e);
				const msg = `${name}: ${errMsg}`;
				this.warnOnce(`compute_failed|${targetId}`, `Compute failed (will retry/keep last): ${msg}`);
				try {
					await this.setStateAsync('info.lastError', msg, true);
				} catch {
					// ignore
				}

				const prev = this.consecutiveErrorCounts.get(targetId) || 0;
				const next = prev + 1;
				this.consecutiveErrorCounts.set(targetId, next);
				try {
					await this.setStateAsync(`${itemInfoBase}.lastError`, errMsg, true);
					await this.setStateAsync(`${itemInfoBase}.lastEvalMs`, Date.now() - itemStart, true);
					await this.setStateAsync(`${itemInfoBase}.consecutiveErrors`, next, true);
				} catch {
					// ignore
				}

				// Policy: keep last good value for N retries, then set to 0.
				if (this.lastGoodValue.has(targetId) && next <= retriesBeforeZero) {
					try {
						await this.setStateAsync(targetId, this.lastGoodValue.get(targetId), true);
					} catch {
						// ignore write errors
					}
				} else if (next > retriesBeforeZero) {
					try {
						await this.setStateAsync(targetId, this.getZeroValueForItem(item), true);
					} catch {
						// ignore write errors
					}
				}
			}
		}

		this.currentSnapshot = null;

		try {
			await this.setStateAsync('info.skippedItems', skippedItems, true);
			await this.setStateAsync('info.lastRun', new Date().toISOString(), true);
			await this.setStateAsync('info.evalTimeMs', Date.now() - start, true);
		} catch {
			// ignore
		}
	}

	onUnload(callback) {
		try {
			this.isUnloading = true;
			if (this.tickTimer) {
				clearTimeout(this.tickTimer);
				this.tickTimer = null;
			}
			callback();
		} catch {
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new DataSolectrus(options);
} else {
	(() => new DataSolectrus())();
}
