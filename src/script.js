const API_BASE = '';
const LAST_DATA_UPDATE_KEY = 'ww_last_data_update';
const SALES_PENDING_SYNC_PREFIX = 'ww_pending_sales_sync_';
const SALES_PENDING_SYNC_TS_PREFIX = 'ww_pending_sales_sync_ts_';
const LOCKED_SALES_MONTHS = {};
const SALES_PROTECTED_PREFIX = 'ww_sales_protected_';
const SALES_VERSION_PREFIX = 'ww_sales_version_';
const SALES_MONTH_DEDUPE_MIGRATION_KEY = 'ww_sales_month_dedupe_v2';
const SALES_YEAR_RESEQUENCE_MIGRATION_KEY = 'ww_sales_year_resequence_v1';
const LEGACY_MARCH_SALES_CLEANUP_KEY = 'ww_march2026_sales_cleanup_v2';
const MAY_RESET_MIGRATION_KEY = 'ww_sales_may2026_reset_v1';
const SALES_SERVER_AUTHORITATIVE_MODE = true;
const CLIENT_INSTANCE_ID = (() => {
	try {
		const existing = sessionStorage.getItem('ww_client_instance_id');
		if (existing) return existing;
		const next = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		sessionStorage.setItem('ww_client_instance_id', next);
		return next;
	} catch (_e) {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
})();

function getSyncSourceMeta() {
	return { instanceId: CLIENT_INSTANCE_ID };
}

function isOwnRealtimeUpdate(payload) {
	const id = String(payload && payload.source && payload.source.instanceId || '').trim();
	return !!id && id === CLIENT_INSTANCE_ID;
}

function shouldProcessRealtimePayload(payload) {
	if (isOwnRealtimeUpdate(payload)) return false;
	const key = String(payload && payload.key || '*');
	const now = Date.now();
	const cache = window.__wwRealtimeDedup || (window.__wwRealtimeDedup = new Map());
	const last = Number(cache.get(key) || 0);
	if (now - last < 600) return false;
	cache.set(key, now);
	return true;
}

function getPendingSalesSyncKey(month) {
	return `${SALES_PENDING_SYNC_PREFIX}${month}`;
}

function getPendingSalesSyncTsKey(month) {
	return `${SALES_PENDING_SYNC_TS_PREFIX}${month}`;
}

function getSalesMonthFromStorageKey(key) {
	if (typeof key !== 'string') return '';
	const match = /^ww_sales_(\d{4}-\d{2})$/.exec(key);
	return match && match[1] ? match[1] : '';
}

function getSalesProtectedKey(month) {
	return `${SALES_PROTECTED_PREFIX}${month}`;
}

function getSalesVersionKey(month) {
	return `${SALES_VERSION_PREFIX}${month}`;
}

function isCanonicalExcelMarchMonth(monthOrKey) {
	// March remains editable; do not force server-authoritative overwrite.
	return false;
}

function hasPendingSalesSyncForKey(key) {
	const month = getSalesMonthFromStorageKey(key);
	if (!month) return false;
	const payloadRaw = localStorage.getItem(getPendingSalesSyncKey(month));
	if (!payloadRaw) return false;
	const tsRaw = localStorage.getItem(getPendingSalesSyncTsKey(month));
	const ts = Number(tsRaw || '0');
	if (!Number.isFinite(ts) || ts <= 0) return true;
	const ageMs = Date.now() - ts;
	const staleMs = 30000;
	if (ageMs > staleMs) {
		clearPendingSalesSync(month);
		return false;
	}
	return true;
}

function queuePendingSalesSync(month, data) {
	if (!month) return;
	try {
		localStorage.setItem(getPendingSalesSyncKey(month), JSON.stringify(data));
		localStorage.setItem(getPendingSalesSyncTsKey(month), String(Date.now()));
	} catch (_e) { /* ignore */ }
}

function clearPendingSalesSync(month) {
	if (!month) return;
	try {
		localStorage.removeItem(getPendingSalesSyncKey(month));
		localStorage.removeItem(getPendingSalesSyncTsKey(month));
	} catch (_e) { /* ignore */ }
}

function getPendingSalesSyncPayload(month) {
	if (!month) return null;
	try {
		const raw = localStorage.getItem(getPendingSalesSyncKey(month));
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch (_e) {
		return null;
	}
}

function normalizeIdArray(values) {
	if (!Array.isArray(values)) return [];
	return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean)));
}

function sanitizeSalesPayloadVersion(payload) {
	const version = Number(payload?.__wwLocalVersion || 0);
	return Number.isFinite(version) && version > 0 ? Math.floor(version) : 0;
}

function getProtectedSalesPayload(month) {
	if (!month) return null;
	try {
		const raw = localStorage.getItem(getSalesProtectedKey(month));
		const parsed = raw ? JSON.parse(raw) : null;
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch (_e) {
		return null;
	}
}

function setProtectedSalesPayload(month, payload) {
	if (!month || !payload || typeof payload !== 'object') return;
	const lockedCfg = getLockedSalesMonthConfig(month);
	const incomingIsLockedCanonical = !!(lockedCfg && isLockedSalesPayload(month, payload));
	const incomingVersion = sanitizeSalesPayloadVersion(payload);
	const existing = getProtectedSalesPayload(month);
	const existingVersion = sanitizeSalesPayloadVersion(existing);
	if (incomingVersion > existingVersion || incomingIsLockedCanonical) {
		try { localStorage.setItem(getSalesProtectedKey(month), JSON.stringify(payload)); } catch (_e) {}
		return;
	}
	if (existing && existingVersion === incomingVersion && existingVersion > 0) {
		const existingIds = new Set((Array.isArray(existing.invoices) ? existing.invoices : []).map((i) => String(i && i.id || '')).filter(Boolean));
		const incomingIds = new Set((Array.isArray(payload.invoices) ? payload.invoices : []).map((i) => String(i && i.id || '')).filter(Boolean));
		const deletedIds = new Set((Array.isArray(payload.deletedInvoiceIds) ? payload.deletedInvoiceIds : []).map(String));
		const unaccounted = [...existingIds].filter((id) => !incomingIds.has(id) && !deletedIds.has(id));
		if (!incomingIsLockedCanonical && unaccounted.length > 0) return;
	}
	try {
		localStorage.setItem(getSalesProtectedKey(month), JSON.stringify(payload));
	} catch (_e) { /* ignore */ }
}

function getNextSalesLocalVersion(month) {
	if (!month) return 1;
	const key = getSalesVersionKey(month);
	let version = 0;
	try {
		version = Number(localStorage.getItem(key) || '0');
	} catch (_e) {
		version = 0;
	}
	if (!Number.isFinite(version) || version < 0) version = 0;
	const next = Math.floor(version) + 1;
	try {
		localStorage.setItem(key, String(next));
	} catch (_e) { /* ignore */ }
	return next;
}

function invoiceSignature(inv) {
	if (!inv || typeof inv !== 'object') return '';
	const firstItem = Array.isArray(inv.items) && inv.items[0] ? inv.items[0] : null;
	const itemName = String((firstItem && firstItem.name) || inv.product || '').trim().toLowerCase();
	const qty = Number((firstItem && firstItem.qty) || 0);
	const unitPrice = Number((firstItem && firstItem.unitPrice) || inv.rate || 0);
	return [
		String(inv.id || '').trim(),
		String(inv.customer || '').trim().toLowerCase(),
		String(inv.date || '').trim(),
		String(inv.phone || '').trim(),
		String(inv.address || '').trim(),
		String(inv.paidDate || '').trim(),
		Number(inv.amount || 0),
		itemName,
		qty,
		unitPrice,
		String(inv.paymentMode || '').trim().toLowerCase(),
		String(inv.carType || '').trim().toLowerCase(),
		String(inv.carNumber || '').trim().toLowerCase(),
	].join('|');
}

function invoiceContentFingerprint(inv) {
	if (!inv || typeof inv !== 'object') return '';
	const firstItem = Array.isArray(inv.items) && inv.items[0] ? inv.items[0] : null;
	const itemName = String((firstItem && firstItem.name) || inv.product || '').trim().toLowerCase();
	const qty = Number((firstItem && firstItem.qty) || 0);
	const unitPrice = Number((firstItem && firstItem.unitPrice) || inv.rate || 0);
	return [
		String(inv.customer || '').trim().toLowerCase(),
		String(inv.date || '').trim(),
		String(inv.phone || '').trim(),
		String(inv.address || '').trim(),
		String(inv.paidDate || '').trim(),
		Number(inv.amount || 0),
		itemName,
		qty,
		unitPrice,
		String(inv.paymentMode || '').trim().toLowerCase(),
		String(inv.carType || '').trim().toLowerCase(),
		String(inv.carNumber || '').trim().toLowerCase(),
		Number(inv.promo || 0),
		String(inv.promoNote || '').trim(),
		String(inv.entryTime || '').trim(),
		String(inv.createdAt || '').trim(),
	].join('|');
}

function orderSignature(ord) {
	if (!ord || typeof ord !== 'object') return '';
	return [
		String(ord.id || '').trim(),
		String(ord.customer || '').trim().toLowerCase(),
		String(ord.orderDate || ord.date || '').trim(),
		Number(ord.amount || 0),
		Number(ord.rate || 0),
		String(ord.paymentMode || '').trim().toLowerCase(),
		String(ord.carType || '').trim().toLowerCase(),
		String(ord.carNumber || '').trim().toLowerCase(),
		String(ord.sourceInvoiceId || '').trim(),
	].join('|');
}

function orderContentFingerprint(ord) {
	if (!ord || typeof ord !== 'object') return '';
	return [
		String(ord.customer || '').trim().toLowerCase(),
		String(ord.orderDate || ord.date || '').trim(),
		Number(ord.amount || 0),
		Number(ord.rate || 0),
		Number(ord.bags || 0),
		String(ord.paymentMode || '').trim().toLowerCase(),
		String(ord.carType || '').trim().toLowerCase(),
		String(ord.carNumber || '').trim().toLowerCase(),
		Number(ord.promo || 0),
		String(ord.promoNote || '').trim(),
		String(ord.createdAt || '').trim(),
	].join('|');
}

function dedupeSalesRecordsByContent(records, fingerprintFn) {
	if (!Array.isArray(records) || !records.length) return [];
	const byFingerprint = new Map();
	const byIdFallback = new Map();
	for (const record of records) {
		if (!record || !record.id) continue;
		const fp = typeof fingerprintFn === 'function' ? String(fingerprintFn(record) || '') : '';
		if (!fp) {
			const id = String(record.id);
			const existingById = byIdFallback.get(id);
			byIdFallback.set(id, pickNewerRecord(existingById, record));
			continue;
		}
		const existing = byFingerprint.get(fp);
		if (!existing) {
			byFingerprint.set(fp, record);
			continue;
		}
		byFingerprint.set(fp, pickNewerRecord(existing, record));
	}
	return [...byFingerprint.values(), ...byIdFallback.values()];
}

function formatVehicleLabel(carType, carNumber) {
	const type = String(carType || '').trim();
	const number = String(carNumber || '').trim();
	if (type && number) return `${type} - ${number}`;
	if (type) return type;
	return number;
}

function getInvoiceDisplayId(invoice) {
	if (!invoice || !invoice.id) return String(invoice?.id || '');
	const monthToken = /^\d{4}-\d{2}$/.test(String(currentSalesMonth || ''))
		? String(currentSalesMonth)
		: String(getInvoiceMonth(invoice) || '').trim();
	if (!monthToken) return String(invoice.id);
	const invoices = (Array.isArray(salesModuleData.invoices) ? salesModuleData.invoices : [])
		.filter((inv) => inv && inv.id && getInvoiceMonth(inv) === monthToken)
		.sort((a, b) => {
			const da = String(a.date || a.orderDate || '');
			const db = String(b.date || b.orderDate || '');
			const dateDiff = da.localeCompare(db);
			if (dateDiff !== 0) return dateDiff;
			const na = Number(String(a.id || '').match(/(\d+)$/)?.[1] || 0);
			const nb = Number(String(b.id || '').match(/(\d+)$/)?.[1] || 0);
			return na - nb;
		});
	const idx = invoices.findIndex((inv) => String(inv.id) === String(invoice.id));
	if (idx < 0) return String(invoice.id);
	return `INV-${monthToken}-${String(idx + 1).padStart(3, '0')}`;
}

function getRecordUpdatedMs(record) {
	if (!record || typeof record !== 'object') return 0;
	const raw = record.updatedAt || record.modifiedAt || record.createdAt || '';
	const ms = Date.parse(String(raw || ''));
	return Number.isFinite(ms) ? ms : 0;
}

function getRecordSignature(record) {
	if (!record || typeof record !== 'object') return '';
	const id = String(record.id || '').trim();
	if (/^INV-/.test(id)) return invoiceSignature(record);
	if (/^SO-/.test(id)) return orderSignature(record);
	return JSON.stringify(record);
}

function pickNewerRecord(existing, incoming) {
	if (!existing) return incoming;
	if (!incoming) return existing;
	const existingMs = getRecordUpdatedMs(existing);
	const incomingMs = getRecordUpdatedMs(incoming);
	if (incomingMs > existingMs) return incoming;
	return existing;
}

function getLockedSalesMonthConfig(month) {
	if (!month) return null;
	return LOCKED_SALES_MONTHS[month] || null;
}

function isLockedSalesPayload(month, payload) {
	const cfg = getLockedSalesMonthConfig(month);
	if (!cfg) return false;
	if (!payload || typeof payload !== 'object') return false;
	const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
	if (invoices.length !== cfg.count) return false;
	if (!Number.isFinite(Number(cfg.total))) return true;
	const total = invoices.reduce((sum, inv) => sum + Number(inv?.amount || 0), 0);
	return Math.abs(total - Number(cfg.total)) < 0.01;
}

function getLockedSalesPayload(month) {
	const cfg = getLockedSalesMonthConfig(month);
	if (!cfg) return null;
	try {
		const raw = localStorage.getItem(cfg.key);
		const parsed = raw ? JSON.parse(raw) : null;
		return isLockedSalesPayload(month, parsed) ? parsed : null;
	} catch (_e) {
		return null;
	}
}

function enforceLockedSalesPayload(month) {
	const locked = getLockedSalesPayload(month);
	if (!locked) return null;
	try {
		localStorage.setItem(monthStorageKey(month), JSON.stringify(locked));
		queuePendingSalesSync(month, locked);
	} catch (_e) { /* ignore */ }
	return locked;
}

function updateLockedSalesPayloadIfCanonical(month, payload) {
	const cfg = getLockedSalesMonthConfig(month);
	if (!cfg) return;
	if (!isLockedSalesPayload(month, payload)) return;
	try {
		localStorage.setItem(cfg.key, JSON.stringify(payload));
	} catch (_e) { /* ignore */ }
}

function getSalesMonthPayload(month) {
	try {
		const raw = localStorage.getItem(monthStorageKey(month));
		const parsed = raw ? JSON.parse(raw) : null;
		const payload = parsed && typeof parsed === 'object' ? parsed : {};
		const protectedPayload = getProtectedSalesPayload(month);
		if (getLockedSalesMonthConfig(month)) {
			if (isLockedSalesPayload(month, payload)) {
				updateLockedSalesPayloadIfCanonical(month, payload);
				setProtectedSalesPayload(month, payload);
				return payload;
			}
			const locked = getLockedSalesPayload(month);
			if (locked) {
				localStorage.setItem(monthStorageKey(month), JSON.stringify(locked));
				queuePendingSalesSync(month, locked);
				return locked;
			}
			if (isLockedSalesPayload(month, protectedPayload)) {
				updateLockedSalesPayloadIfCanonical(month, protectedPayload);
				localStorage.setItem(monthStorageKey(month), JSON.stringify(protectedPayload));
				queuePendingSalesSync(month, protectedPayload);
				return protectedPayload;
			}
		}
		const payloadVersion = sanitizeSalesPayloadVersion(payload);
		const protectedVersion = sanitizeSalesPayloadVersion(protectedPayload);
		if (protectedPayload && protectedVersion > payloadVersion) {
			localStorage.setItem(monthStorageKey(month), JSON.stringify(protectedPayload));
			queuePendingSalesSync(month, protectedPayload);
			return protectedPayload;
		}
		if (protectedPayload && protectedVersion === payloadVersion && protectedVersion > 0) {
			const protectedIds = new Set((Array.isArray(protectedPayload.invoices) ? protectedPayload.invoices : []).map((i) => String(i && i.id || '')).filter(Boolean));
			const payloadIds = new Set((Array.isArray(payload.invoices) ? payload.invoices : []).map((i) => String(i && i.id || '')).filter(Boolean));
			const deletedIds = new Set((Array.isArray(payload.deletedInvoiceIds) ? payload.deletedInvoiceIds : []).map(String));
			const unaccounted = [...protectedIds].filter((id) => !payloadIds.has(id) && !deletedIds.has(id));
			if (unaccounted.length > 0) {
				localStorage.setItem(monthStorageKey(month), JSON.stringify(protectedPayload));
				queuePendingSalesSync(month, protectedPayload);
				return protectedPayload;
			}
			return payload;
		}
		if (month && payload && typeof payload === 'object') {
			if (payloadVersion >= protectedVersion) setProtectedSalesPayload(month, payload);
		}
		if (getLockedSalesMonthConfig(month)) {
			if (isLockedSalesPayload(month, payload)) {
				updateLockedSalesPayloadIfCanonical(month, payload);
				return payload;
			}
			const locked = getLockedSalesPayload(month);
			if (locked) {
				localStorage.setItem(monthStorageKey(month), JSON.stringify(locked));
				queuePendingSalesSync(month, locked);
				return locked;
			}
		}
		return payload;
	} catch (_e) {
		if (getLockedSalesMonthConfig(month)) {
			const locked = getLockedSalesPayload(month);
			if (locked) return locked;
		}
		return {};
	}
}

function mergeSalesMonthPayloads(localPayload, incomingPayload, month) {
	if (month && getLockedSalesMonthConfig(month)) {
		const locked = getLockedSalesPayload(month);
		if (locked) return locked;
		if (isLockedSalesPayload(month, localPayload)) return localPayload;
	}
	const local = localPayload && typeof localPayload === 'object' ? localPayload : {};
	const incoming = incomingPayload && typeof incomingPayload === 'object' ? incomingPayload : {};
	const localInv = Array.isArray(local.invoices) ? local.invoices : [];
	const incomingInv = Array.isArray(incoming.invoices) ? incoming.invoices : [];
	const localOrd = Array.isArray(local.salesOrders) ? local.salesOrders : [];
	const incomingOrd = Array.isArray(incoming.salesOrders) ? incoming.salesOrders : [];

	// Prefer local records for matching IDs, but keep any incoming IDs not present locally.
	const invById = new Map();
	localInv.forEach((inv) => {
		if (inv && inv.id) invById.set(String(inv.id), inv);
	});
	incomingInv.forEach((inv) => {
		if (!inv || !inv.id) return;
		const id = String(inv.id);
		const existing = invById.get(id);
		invById.set(id, pickNewerRecord(existing, inv));
	});

	const ordById = new Map();
	localOrd.forEach((ord) => {
		if (ord && ord.id) ordById.set(String(ord.id), ord);
	});
	incomingOrd.forEach((ord) => {
		if (!ord || !ord.id) return;
		const id = String(ord.id);
		const existing = ordById.get(id);
		ordById.set(id, pickNewerRecord(existing, ord));
	});

	const deletedInvoiceIds = normalizeIdArray([...(local.deletedInvoiceIds || []), ...(incoming.deletedInvoiceIds || [])]);
	const deletedOrderIds = normalizeIdArray([...(local.deletedOrderIds || []), ...(incoming.deletedOrderIds || [])]);
	const delInv = new Set(deletedInvoiceIds.map((id) => String(id)));
	const delOrd = new Set(deletedOrderIds.map((id) => String(id)));
	const enforceDateFilter = shouldEnforceMonthDateFilter(month);

	const invoices = Array.from(invById.values()).filter((inv) => {
		if (!inv || !inv.id) return false;
		if (delInv.has(String(inv.id))) return false;
		const invMonth = getInvoiceMonth(inv);
		if (enforceDateFilter && month && invMonth && invMonth !== month) return false;
		return true;
	});
	const activeInvoiceIds = new Set(invoices.map((inv) => String(inv.id)).filter(Boolean));
	const salesOrders = Array.from(ordById.values()).filter((ord) => {
		if (!ord || !ord.id) return false;
		if (delOrd.has(String(ord.id))) return false;
		if (ord.sourceInvoiceId && delInv.has(String(ord.sourceInvoiceId))) return false;
		if (ord.sourceInvoiceId && !activeInvoiceIds.has(String(ord.sourceInvoiceId))) return false;
		const ordMonth = getInvoiceMonth(ord);
		if (enforceDateFilter && month && ordMonth && ordMonth !== month) return false;
		return true;
	});

	const localVersion = sanitizeSalesPayloadVersion(local);
	const incomingVersion = sanitizeSalesPayloadVersion(incoming);
	const mergedVersion = Math.max(localVersion, incomingVersion);
	return { invoices, salesOrders, deletedInvoiceIds, deletedOrderIds, ...(mergedVersion > 0 ? { __wwLocalVersion: mergedVersion } : {}) };
}

function areSalesPayloadsEquivalent(localPayload, incomingPayload) {
	const local = localPayload && typeof localPayload === 'object' ? localPayload : {};
	const incoming = incomingPayload && typeof incomingPayload === 'object' ? incomingPayload : {};

	const localInv = Array.isArray(local.invoices) ? local.invoices : [];
	const incomingInv = Array.isArray(incoming.invoices) ? incoming.invoices : [];
	if (localInv.length !== incomingInv.length) return false;
	const incomingInvById = new Map(incomingInv.filter((inv) => inv && inv.id).map((inv) => [String(inv.id), inv]));
	for (const inv of localInv) {
		if (!inv || !inv.id) return false;
		const match = incomingInvById.get(String(inv.id));
		if (!match) return false;
		if (invoiceSignature(inv) !== invoiceSignature(match)) return false;
	}

	const localOrd = Array.isArray(local.salesOrders) ? local.salesOrders : [];
	const incomingOrd = Array.isArray(incoming.salesOrders) ? incoming.salesOrders : [];
	if (localOrd.length !== incomingOrd.length) return false;
	const incomingOrdById = new Map(incomingOrd.filter((ord) => ord && ord.id).map((ord) => [String(ord.id), ord]));
	for (const ord of localOrd) {
		if (!ord || !ord.id) return false;
		const match = incomingOrdById.get(String(ord.id));
		if (!match) return false;
		if (orderSignature(ord) !== orderSignature(match)) return false;
	}

	const localDelInv = normalizeIdArray(local.deletedInvoiceIds).sort();
	const incomingDelInv = normalizeIdArray(incoming.deletedInvoiceIds).sort();
	if (localDelInv.length !== incomingDelInv.length) return false;
	for (let i = 0; i < localDelInv.length; i += 1) {
		if (localDelInv[i] !== incomingDelInv[i]) return false;
	}

	const localDelOrd = normalizeIdArray(local.deletedOrderIds).sort();
	const incomingDelOrd = normalizeIdArray(incoming.deletedOrderIds).sort();
	if (localDelOrd.length !== incomingDelOrd.length) return false;
	for (let i = 0; i < localDelOrd.length; i += 1) {
		if (localDelOrd[i] !== incomingDelOrd[i]) return false;
	}

	return true;
}

function buildSalesSyncPayload(month, data) {
	const existing = getSalesMonthPayload(month);
	const existingVersion = sanitizeSalesPayloadVersion(existing);
	const dataVersion = sanitizeSalesPayloadVersion(data);
	const version = Math.max(existingVersion, dataVersion);
	const activeInvoiceIds = new Set((Array.isArray(data?.invoices) ? data.invoices : []).map((inv) => String(inv?.id || '')).filter(Boolean));
	const activeOrderIds = new Set((Array.isArray(data?.salesOrders) ? data.salesOrders : []).map((ord) => String(ord?.id || '')).filter(Boolean));
	const deletedInvoiceIds = normalizeIdArray(existing.deletedInvoiceIds).filter((id) => !activeInvoiceIds.has(String(id)));
	const deletedOrderIds = normalizeIdArray(existing.deletedOrderIds).filter((id) => !activeOrderIds.has(String(id)));
	const delInv = new Set(deletedInvoiceIds);
	const delOrd = new Set(deletedOrderIds);
	const invoices = (Array.isArray(data?.invoices) ? data.invoices : []).filter((inv) => inv && inv.id && !delInv.has(String(inv.id)));
	const salesOrders = (Array.isArray(data?.salesOrders) ? data.salesOrders : []).filter((ord) => {
		if (!ord || !ord.id) return false;
		if (delOrd.has(String(ord.id))) return false;
		if (ord.sourceInvoiceId && delInv.has(String(ord.sourceInvoiceId))) return false;
		return true;
	});
	const reconciledDeletedInv = normalizeIdArray(Array.from(delInv));
	return {
		invoices,
		salesOrders,
		deletedInvoiceIds: reconciledDeletedInv,
		deletedOrderIds,
		...(version > 0 ? { __wwLocalVersion: version } : {}),
	};
}

function markSalesDeletion(month, entity, id) {
	if (!month || !id) return;
	const payload = buildSalesSyncPayload(month, {
		invoices: salesModuleData.invoices,
		salesOrders: salesModuleData.salesOrders,
	});
	if (entity === 'invoice') payload.deletedInvoiceIds = normalizeIdArray([...(payload.deletedInvoiceIds || []), String(id)]);
	if (entity === 'order') payload.deletedOrderIds = normalizeIdArray([...(payload.deletedOrderIds || []), String(id)]);
	localStorage.setItem(monthStorageKey(month), JSON.stringify(payload));
}

function unmarkSalesDeletion(month, entity, id) {
	if (!month || !id) return;
	const payload = buildSalesSyncPayload(month, {
		invoices: salesModuleData.invoices,
		salesOrders: salesModuleData.salesOrders,
	});
	if (entity === 'invoice') payload.deletedInvoiceIds = (payload.deletedInvoiceIds || []).filter((v) => String(v) !== String(id));
	if (entity === 'order') payload.deletedOrderIds = (payload.deletedOrderIds || []).filter((v) => String(v) !== String(id));
	localStorage.setItem(monthStorageKey(month), JSON.stringify(payload));
}

// Fetch server state for a sales month, merge with localData (local wins on same ID),
// update localStorage + in-memory salesModuleData if it's the current month, then push.
async function mergeSyncSalesMonth(month, localData) {
	const key = monthStorageKey(month);
	let toSync = buildSalesSyncPayload(month, localData);
	const enforceDateFilter = shouldEnforceMonthDateFilter(month);
	try {
		const res = await fetch(API_BASE + '/api/app-data/' + encodeURIComponent(key), { credentials: 'include', cache: 'no-store' });
		if (res.ok) {
			const json = await res.json();
			const serverData = json && json.data;
			if (serverData && typeof serverData === 'object') {
				const serverInvs = Array.isArray(serverData.invoices) ? serverData.invoices : [];
				const serverOrds = Array.isArray(serverData.salesOrders) ? serverData.salesOrders : [];
				const localInvs = Array.isArray(toSync.invoices) ? toSync.invoices : [];
				const localOrds = Array.isArray(toSync.salesOrders) ? toSync.salesOrders : [];
				const mergedDeletedInv = normalizeIdArray([...(toSync.deletedInvoiceIds || []), ...normalizeIdArray(serverData.deletedInvoiceIds)]);
				const mergedDeletedOrd = normalizeIdArray([...(toSync.deletedOrderIds || []), ...normalizeIdArray(serverData.deletedOrderIds)]);
				const delInv = new Set(mergedDeletedInv);
				const delOrd = new Set(mergedDeletedOrd);

				// Merge by ID with local taking precedence so edits persist across refreshes.
				const invoiceById = new Map();
				for (const inv of serverInvs) {
					if (!inv || !inv.id) continue;
					const id = String(inv.id);
					if (delInv.has(id)) continue;
					invoiceById.set(id, pickNewerRecord(invoiceById.get(id), inv));
				}
				for (const inv of localInvs) {
					if (!inv || !inv.id) continue;
					const id = String(inv.id);
					if (delInv.has(id)) continue;
					invoiceById.set(id, pickNewerRecord(invoiceById.get(id), inv));
				}
				const mergedInvoices = Array.from(invoiceById.values()).filter((inv) => {
					if (!inv || !inv.id) return false;
					const invMonth = getInvoiceMonth(inv);
					if (enforceDateFilter && month && invMonth && invMonth !== month) return false;
					return true;
				});

				const resolveInvoiceLinkFromOrder = (ord) => {
					if (!ord) return '';
					const src = String(ord.sourceInvoiceId || '').trim();
					if (src) return src;
					const m = String(ord.id || '').match(/^SO-(\d{4})(?:-(\d{2}))?-(\d{3})$/);
					if (!m) return '';
					return m[2] ? `INV-${m[1]}-${m[2]}-${m[3]}` : `INV-${m[1]}-${m[3]}`;
				};

				const activeInvoiceIds = new Set(mergedInvoices.map((inv) => String(inv.id || '')).filter(Boolean));
				const orderById = new Map();
				for (const ord of serverOrds) {
					if (!ord || !ord.id) continue;
					const id = String(ord.id);
					if (delOrd.has(id)) continue;
					const src = resolveInvoiceLinkFromOrder(ord);
					if (!src || !activeInvoiceIds.has(String(src)) || delInv.has(String(src))) continue;
					ord.sourceInvoiceId = src;
					orderById.set(id, pickNewerRecord(orderById.get(id), ord));
				}
				for (const ord of localOrds) {
					if (!ord || !ord.id) continue;
					const id = String(ord.id);
					if (delOrd.has(id)) continue;
					const src = resolveInvoiceLinkFromOrder(ord);
					if (!src || !activeInvoiceIds.has(String(src)) || delInv.has(String(src))) continue;
					ord.sourceInvoiceId = src;
					orderById.set(id, pickNewerRecord(orderById.get(id), ord));
				}
				const mergedOrders = Array.from(orderById.values()).filter((ord) => {
					if (!ord || !ord.id) return false;
					if (ord.sourceInvoiceId && !activeInvoiceIds.has(String(ord.sourceInvoiceId))) return false;
					const ordMonth = getInvoiceMonth(ord);
					if (enforceDateFilter && month && ordMonth && ordMonth !== month) return false;
					return true;
				});

				toSync = { invoices: mergedInvoices, salesOrders: mergedOrders, deletedInvoiceIds: mergedDeletedInv, deletedOrderIds: mergedDeletedOrd };
				localStorage.setItem(key, JSON.stringify(toSync));
				if (month === currentSalesMonth) {
					salesModuleData.invoices = mergedInvoices;
					salesModuleData.salesOrders = mergedOrders;
				}
			}
		}
	} catch (_e) { /* fall back to local-only push */ }

	const pushed = await syncToServer(key, toSync);
	if (!pushed) return false;

	// Concurrency guard: if another device wrote between our fetch and put,
	// re-fetch and push one reconciled union so both devices converge.
	try {
		const latestRes = await fetch(API_BASE + '/api/app-data/' + encodeURIComponent(key), { credentials: 'include', cache: 'no-store' });
		if (!latestRes.ok) return true;
		const latestJson = await latestRes.json();
		const latestData = latestJson && latestJson.data;
		if (!latestData || typeof latestData !== 'object') return true;

		const reconciled = mergeSalesMonthPayloads(latestData, toSync, month);
		if (areSalesPayloadsEquivalent(reconciled, latestData)) return true;

		const reconciledOk = await syncToServer(key, reconciled);
		if (!reconciledOk) return true;

		localStorage.setItem(key, JSON.stringify(reconciled));
		if (month === currentSalesMonth) {
			salesModuleData.invoices = Array.isArray(reconciled.invoices) ? [...reconciled.invoices] : [];
			salesModuleData.salesOrders = Array.isArray(reconciled.salesOrders) ? [...reconciled.salesOrders] : [];
		}
	} catch (_e) { /* keep optimistic success */ }

	return true;
}

async function flushPendingSalesSyncToServer() {
	const pendingKeys = [];
	for (let i = 0; i < localStorage.length; i += 1) {
		const key = localStorage.key(i);
		if (key && key.startsWith(SALES_PENDING_SYNC_PREFIX)) pendingKeys.push(key);
	}
	for (const pendingKey of pendingKeys) {
		const month = pendingKey.slice(SALES_PENDING_SYNC_PREFIX.length);
		if (!month) continue;
		try {
			const raw = localStorage.getItem(pendingKey);
			if (!raw) continue;
			const data = JSON.parse(raw);
			const ok = await mergeSyncSalesMonth(month, data);
			if (ok) clearPendingSalesSync(month);
		} catch (_e) { /* keep pending for next attempt */ }
	}
}

function getLastDataUpdateStamp() {
	try {
		const raw = localStorage.getItem(LAST_DATA_UPDATE_KEY);
		if (!raw) return '';
		const parsed = JSON.parse(raw);
		return typeof parsed === 'string' ? parsed : '';
	} catch (_e) {
		const fallback = localStorage.getItem(LAST_DATA_UPDATE_KEY);
		return typeof fallback === 'string' ? fallback : '';
	}
}

function setLastDataUpdateStamp(value) {
	if (!value) return;
	localStorage.setItem(LAST_DATA_UPDATE_KEY, JSON.stringify(value));
}

function putAppDataKeyToServer(key, data, logResult = true) {
	const body = JSON.stringify({ data, __source: getSyncSourceMeta() });
	return fetch(API_BASE + '/api/app-data/' + encodeURIComponent(key), {
		method: 'PUT', credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body,
	})
	.then(res => {
		if (logResult) {
			if (!res.ok) console.error('[Sync] FAILED to save', key, '— HTTP', res.status);
			else console.log('[Sync] Saved', key, '✓');
		}
		return res.ok;
	})
	.catch(err => {
		if (logResult) console.error('[Sync] Network error saving', key, err);
		return false;
	});
}

/* ── Server persistence helpers ── */
function syncToServer(key, data) {
	const stamp = new Date().toISOString();
	if (key !== LAST_DATA_UPDATE_KEY) {
		setLastDataUpdateStamp(stamp);
		putAppDataKeyToServer(LAST_DATA_UPDATE_KEY, stamp, false);
	}
	return putAppDataKeyToServer(key, data, true);
}

async function clearSalesBrowserCacheIfServerEmpty() {
	try {
		const res = await fetch(API_BASE + '/api/app-data/ww_sales_months', { credentials: 'include', cache: 'no-store' });
		if (!res.ok) return false;
		const json = await res.json();
		if (Array.isArray(json?.data) && json.data.length > 0) return false;
		const keysToRemove = [];
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i);
			if (!key) continue;
			if (key === 'ww_sales_months' || key === 'ww_sales_data' || key === 'ww_last_data_update') {
				keysToRemove.push(key);
				continue;
			}
			if (key.startsWith('ww_sales_') || key.startsWith('ww_pending_sales_sync_') || key.startsWith('ww_pending_sales_sync_ts_') || key.startsWith('ww_sales_protected_') || key.startsWith('ww_sales_version_')) {
				keysToRemove.push(key);
			}
		}
		keysToRemove.forEach((key) => localStorage.removeItem(key));
		return keysToRemove.length > 0;
	} catch (_e) {
		return false;
	}
}

async function reloadSalesMonthsFromServerHard() {
	try {
		const monthsRes = await fetch(API_BASE + '/api/app-data/ww_sales_months', { credentials: 'include', cache: 'no-store' });
		if (!monthsRes.ok) return false;
		const monthsJson = await monthsRes.json();
		const serverMonths = Array.isArray(monthsJson?.data)
			? monthsJson.data.filter((m) => /^\d{4}-\d{2}$/.test(String(m)))
			: [];
		const monthSet = new Set(serverMonths);

		try { localStorage.setItem(MONTHS_KEY, JSON.stringify(serverMonths)); } catch (_e) { /* ignore */ }

		const keysToRemove = [];
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i);
			if (!key) continue;
			const match = /^ww_sales_(\d{4}-\d{2})$/.exec(key);
			if (match && match[1] && !monthSet.has(match[1])) {
				keysToRemove.push(key);
				keysToRemove.push(getPendingSalesSyncKey(match[1]));
				keysToRemove.push(getPendingSalesSyncTsKey(match[1]));
				keysToRemove.push(getSalesProtectedKey(match[1]));
				keysToRemove.push(getSalesVersionKey(match[1]));
			}
		}
		keysToRemove.forEach((k) => {
			try { localStorage.removeItem(k); } catch (_e) { /* ignore */ }
		});

		for (const month of serverMonths) {
			const key = monthStorageKey(month);
			try {
				const res = await fetch(API_BASE + '/api/app-data/' + encodeURIComponent(key), { credentials: 'include', cache: 'no-store' });
				if (!res.ok) continue;
				const json = await res.json();
				if (json && json.data && typeof json.data === 'object') {
					const localPayload = getSalesMonthPayload(month);
					const hasPending = hasPendingSalesSyncForKey(key);
					if (hasPending) {
						const merged = mergeSalesMonthPayloads(localPayload, json.data, month);
						localStorage.setItem(key, JSON.stringify(merged));
						setProtectedSalesPayload(month, merged);
					} else {
						localStorage.setItem(key, JSON.stringify(json.data));
						setProtectedSalesPayload(month, json.data);
						clearPendingSalesSync(month);
					}
				}
			} catch (_e) { /* ignore */ }
		}

		return true;
	} catch (_e) {
		return false;
	}
}

function moveAppDataDeleteToTrash(module, recordData, restoreMeta) {
	if (!recordData || !restoreMeta) return Promise.resolve(false);
	return fetch(API_BASE + '/api/trash/app-data-delete', {
		method: 'POST', credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ module, recordData, restoreMeta }),
	})
	.then((res) => {
		if (!res.ok) console.warn('[Trash] Failed to archive deleted record for module:', module);
		return res.ok;
	})
	.catch((_e) => false);
}

/* ── Delete toast notification ── */
function showDeleteToast(message) {
	let container = document.getElementById('ww-toast-container');
	if (!container) {
		container = document.createElement('div');
		container.id = 'ww-toast-container';
		container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
		document.body.appendChild(container);
	}
	const toast = document.createElement('div');
	toast.style.cssText = 'background:#ef4444;color:#fff;padding:10px 18px;border-radius:8px;font-size:0.9rem;font-weight:500;box-shadow:0 4px 16px rgba(0,0,0,0.18);opacity:1;transition:opacity 0.4s;max-width:320px;pointer-events:none;display:flex;align-items:center;gap:8px;';
	toast.innerHTML = `<i class="fa-solid fa-trash-can" style="flex-shrink:0"></i><span>${message}</span>`;
	container.appendChild(toast);
	setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 420); }, 3000);
}

/* ── Seed flag helpers (synced to server so flags persist across devices) ── */
function _getSeedFlags() {
	try { return JSON.parse(localStorage.getItem('ww_seed_flags') || '{}'); } catch (_e) { return {}; }
}
function getSeedFlag(name) { return !!_getSeedFlags()[name]; }
function setSeedFlag(name) {
	const flags = _getSeedFlags();
	if (flags[name]) return;
	flags[name] = 1;
	localStorage.setItem('ww_seed_flags', JSON.stringify(flags));
	syncToServer('ww_seed_flags', flags);
}

async function loadFromServer(key) {
	try {
		const res = await fetch(API_BASE + '/api/app-data/' + encodeURIComponent(key), { credentials: 'include', cache: 'no-store' });
		if (res.ok) {
			const json = await res.json();
			if (json.data !== null && json.data !== undefined) {
				const salesMonth = getSalesMonthFromStorageKey(key);
				if (salesMonth) {
					const hasPending = hasPendingSalesSyncForKey(key);
					if (hasPending) {
						const pendingPayload = getPendingSalesSyncPayload(salesMonth) || getSalesMonthPayload(salesMonth);
						const mergedPending = mergeSalesMonthPayloads(pendingPayload, json.data, salesMonth);
						localStorage.setItem(key, JSON.stringify(mergedPending));
						setProtectedSalesPayload(salesMonth, mergedPending);
						if (areSalesPayloadsEquivalent(mergedPending, json.data)) clearPendingSalesSync(salesMonth);
						else queuePendingSalesSync(salesMonth, mergedPending);
						return mergedPending;
					}
					if (SALES_SERVER_AUTHORITATIVE_MODE) {
						localStorage.setItem(key, JSON.stringify(json.data));
						setProtectedSalesPayload(salesMonth, json.data);
						clearPendingSalesSync(salesMonth);
						return json.data;
					}
					if (isCanonicalExcelMarchMonth(salesMonth)) {
						localStorage.setItem(key, JSON.stringify(json.data));
						setProtectedSalesPayload(salesMonth, json.data);
						clearPendingSalesSync(salesMonth);
						return json.data;
					}
					if (!hasPending) {
						localStorage.setItem(key, JSON.stringify(json.data));
						setProtectedSalesPayload(salesMonth, json.data);
						clearPendingSalesSync(salesMonth);
						return json.data;
					}
					const localPayload = getSalesMonthPayload(salesMonth);
					const merged = mergeSalesMonthPayloads(localPayload, json.data, salesMonth);
					localStorage.setItem(key, JSON.stringify(merged));
					if (areSalesPayloadsEquivalent(merged, json.data)) clearPendingSalesSync(salesMonth);
					else queuePendingSalesSync(salesMonth, merged);
					return merged;
				}
				localStorage.setItem(key, JSON.stringify(json.data));
				return json.data;
			}
		}
	} catch (_e) { /* fall back to localStorage */ }
	return null;
}

// Force-loads from server, bypassing the pending-sync guard. Used during
// cross-device poll so a device that has pending local changes still picks
// up additions made by other devices.
async function loadFromServerForceFresh(key) {
	try {
		const res = await fetch(API_BASE + '/api/app-data/' + encodeURIComponent(key), { credentials: 'include', cache: 'no-store' });
		if (res.ok) {
			const json = await res.json();
			if (json.data !== null && json.data !== undefined) {
				const salesMonth = getSalesMonthFromStorageKey(key);
				if (salesMonth) {
					const hasPending = hasPendingSalesSyncForKey(key);
					if (hasPending) {
						const pendingPayload = getPendingSalesSyncPayload(salesMonth) || getSalesMonthPayload(salesMonth);
						const mergedPending = mergeSalesMonthPayloads(pendingPayload, json.data, salesMonth);
						localStorage.setItem(key, JSON.stringify(mergedPending));
						setProtectedSalesPayload(salesMonth, mergedPending);
						if (areSalesPayloadsEquivalent(mergedPending, json.data)) clearPendingSalesSync(salesMonth);
						else queuePendingSalesSync(salesMonth, mergedPending);
						return mergedPending;
					}
					// Server-authoritative month refresh to eliminate split-brain local state.
					localStorage.setItem(key, JSON.stringify(json.data));
					setProtectedSalesPayload(salesMonth, json.data);
					clearPendingSalesSync(salesMonth);
					return json.data;
				}
				localStorage.setItem(key, JSON.stringify(json.data));
				return json.data;
			}
		}
	} catch (_e) { /* fall back to localStorage */ }
	return null;
}

// Merges server invoice/order records into the current in-memory salesModuleData.
// Only ADDS records that are absent locally (other device's new entries).
// Does NOT resurrect locally-deleted records.
// Returns true if anything was added.
function mergeServerSalesIntoMemory(serverData, targetMonth) {
	const month = String(targetMonth || currentSalesMonth || '');
	if (!/^\d{4}-\d{2}$/.test(month)) return false;
	if (month !== currentSalesMonth) return false;
	if (isCanonicalExcelMarchMonth(month)) {
		if (!serverData || typeof serverData !== 'object') return false;
		salesModuleData.invoices = Array.isArray(serverData.invoices) ? [...serverData.invoices] : [];
		salesModuleData.salesOrders = Array.isArray(serverData.salesOrders) ? [...serverData.salesOrders] : [];
		return true;
	}
	const resolveInvoiceLinkFromOrder = (ord) => {
		if (!ord) return '';
		const source = String(ord.sourceInvoiceId || '').trim();
		if (source) return source;
		const m = String(ord.id || '').match(/^SO-(\d{4})(?:-(\d{2}))?-(\d{3})$/);
		if (!m) return '';
		return m[2] ? `INV-${m[1]}-${m[2]}-${m[3]}` : `INV-${m[1]}-${m[3]}`;
	};
	const protectedPayload = getProtectedSalesPayload(month);
	if (protectedPayload) {
		const protectedVersion = sanitizeSalesPayloadVersion(protectedPayload);
		const serverVersion = sanitizeSalesPayloadVersion(serverData);
		if (protectedVersion >= serverVersion) {
			salesModuleData.invoices = Array.isArray(protectedPayload.invoices) ? [...protectedPayload.invoices] : [];
			salesModuleData.salesOrders = Array.isArray(protectedPayload.salesOrders) ? [...protectedPayload.salesOrders] : [];
			// Keep local protected base, but still ingest any new server records by ID.
		}
	}
	if (!serverData || typeof serverData !== 'object') return false;
	const enforceDateFilter = shouldEnforceMonthDateFilter(month);
	const serverInvoicesRaw = Array.isArray(serverData.invoices) ? serverData.invoices : [];
	const serverOrdersRaw = Array.isArray(serverData.salesOrders) ? serverData.salesOrders : [];
	const serverInvoices = serverInvoicesRaw.filter((inv) => {
		if (!inv || !inv.id) return false;
		if (!enforceDateFilter) return true;
		const m = getInvoiceMonth(inv);
		return !m || m === month;
	});
	const serverInvoiceIds = new Set(serverInvoices.map((inv) => String(inv.id)).filter(Boolean));
	const serverOrders = serverOrdersRaw.filter((ord) => {
		if (!ord || !ord.id) return false;
		const sourceInvoiceId = resolveInvoiceLinkFromOrder(ord);
		if (sourceInvoiceId && serverInvoiceIds.has(String(sourceInvoiceId))) {
			ord.sourceInvoiceId = sourceInvoiceId;
			return true;
		}
		if (!enforceDateFilter) return true;
		const ordMonth = getInvoiceMonth(ord);
		return !ordMonth || ordMonth === month;
	});
	const monthPayload = getSalesMonthPayload(month);
	const deletedInv = new Set(normalizeIdArray([...(monthPayload.deletedInvoiceIds || []), ...normalizeIdArray(serverData.deletedInvoiceIds)]));
	const deletedOrd = new Set(normalizeIdArray([...(monthPayload.deletedOrderIds || []), ...normalizeIdArray(serverData.deletedOrderIds)]));
	const hasLocalPending = hasPendingSalesSyncForKey(monthStorageKey(month));

	// When there are no unsynced local changes, mirror server state so cross-device edits
	// (same IDs with changed fields) appear automatically without manual refresh.
	if (!hasLocalPending) {
		const nextInvoices = serverInvoices.filter((inv) => inv && inv.id && !deletedInv.has(String(inv.id)));
		const activeInvoiceIds = new Set(nextInvoices.map((inv) => String(inv.id)).filter(Boolean));
		const nextOrders = serverOrders
			.filter((ord) => {
				if (!ord || !ord.id) return false;
				if (deletedOrd.has(String(ord.id))) return false;
				const sourceInvoiceId = resolveInvoiceLinkFromOrder(ord);
				if (!sourceInvoiceId || deletedInv.has(String(sourceInvoiceId))) return false;
				if (!activeInvoiceIds.has(String(sourceInvoiceId))) return false;
				ord.sourceInvoiceId = sourceInvoiceId;
				return true;
			});
		const changed =
			JSON.stringify(salesModuleData.invoices) !== JSON.stringify(nextInvoices)
			|| JSON.stringify(salesModuleData.salesOrders) !== JSON.stringify(nextOrders);
		salesModuleData.invoices = nextInvoices;
		salesModuleData.salesOrders = nextOrders;
		return changed;
	}

	const localInvIds = new Set(salesModuleData.invoices.map((inv) => String(inv.id)));
	const localOrdIds = new Set(salesModuleData.salesOrders.map((ord) => String(ord.id)));
	const localInvSignatures = new Set(salesModuleData.invoices.map((inv) => invoiceSignature(inv)).filter(Boolean));
	const localOrdSignatures = new Set(salesModuleData.salesOrders.map((ord) => orderSignature(ord)).filter(Boolean));
	const localInvIndexById = new Map(salesModuleData.invoices.map((inv, idx) => [String(inv.id), idx]));
	const localOrdIndexById = new Map(salesModuleData.salesOrders.map((ord, idx) => [String(ord.id), idx]));
	let changed = false;
	serverInvoices.forEach((inv) => {
		if (!inv || !inv.id) return;
		const invId = String(inv.id);
		if (deletedInv.has(invId)) return;
		const existingIdx = localInvIndexById.get(invId);
		if (existingIdx !== undefined) {
			const existing = salesModuleData.invoices[existingIdx];
			const winner = pickNewerRecord(existing, inv);
			if (winner !== existing) {
				salesModuleData.invoices[existingIdx] = winner;
				changed = true;
			}
			return;
		}
		const sig = invoiceSignature(inv);
		if (!localInvIds.has(invId) && !(sig && localInvSignatures.has(sig))) {
			salesModuleData.invoices.push(inv);
			localInvIds.add(invId);
			localInvIndexById.set(invId, salesModuleData.invoices.length - 1);
			if (sig) localInvSignatures.add(sig);
			changed = true;
		}
	});
	const activeInvoiceIds = new Set(salesModuleData.invoices.map((inv) => String(inv.id)).filter(Boolean));
	serverOrders.forEach((ord) => {
		if (!ord || !ord.id) return;
		const ordId = String(ord.id);
		if (deletedOrd.has(ordId)) return;
		const sourceInvoiceId = resolveInvoiceLinkFromOrder(ord);
		if (!sourceInvoiceId || deletedInv.has(String(sourceInvoiceId))) return;
		if (!activeInvoiceIds.has(String(sourceInvoiceId))) return;
		ord.sourceInvoiceId = sourceInvoiceId;
		const existingIdx = localOrdIndexById.get(ordId);
		if (existingIdx !== undefined) {
			const existing = salesModuleData.salesOrders[existingIdx];
			const winner = pickNewerRecord(existing, ord);
			if (winner !== existing) {
				salesModuleData.salesOrders[existingIdx] = winner;
				changed = true;
			}
			return;
		}
		const sig = orderSignature(ord);
		if (!localOrdIds.has(ordId) && !(sig && localOrdSignatures.has(sig))) {
			salesModuleData.salesOrders.push(ord);
			localOrdIds.add(ordId);
			localOrdIndexById.set(ordId, salesModuleData.salesOrders.length - 1);
			if (sig) localOrdSignatures.add(sig);
			changed = true;
		}
	});
	if (changed) {
		salesModuleData.salesOrders = salesModuleData.salesOrders.filter((ord) => {
			const sourceInvoiceId = resolveInvoiceLinkFromOrder(ord);
			if (!sourceInvoiceId || deletedInv.has(String(sourceInvoiceId))) return false;
			return activeInvoiceIds.has(String(sourceInvoiceId));
		});
	}
	return changed;
}

function applySalesMonthPayloadToUi(month, payload) {
	if (!month || month !== currentSalesMonth) return false;
	if (!payload || typeof payload !== 'object') return false;
	const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
	const orders = Array.isArray(payload.salesOrders) ? payload.salesOrders : [];
	salesModuleData.invoices = [...invoices];
	salesModuleData.salesOrders = [...orders];
	loadMonthData(month);
	renderSalesPage();
	return true;
}

async function loadBulkFromServer(keys) {
	try {
		const res = await fetch(API_BASE + '/api/app-data-bulk?keys=' + keys.map(encodeURIComponent).join(','), { credentials: 'include', cache: 'no-store' });
		if (res.ok) {
			const json = await res.json();
			if (json.items) {
				for (const [k, v] of Object.entries(json.items)) {
					if (v === null || v === undefined) continue;
					// Equipment has a dedicated collection endpoint.
					// Ignore key/value payload for ww_equipment to avoid stale overwrite.
					if (k === 'ww_equipment') continue;
					// For sales month keys, merge server+local by ID to avoid losing local entries.
					const salesMonth = getSalesMonthFromStorageKey(k);
					if (salesMonth) {
						if (SALES_SERVER_AUTHORITATIVE_MODE) {
							if (hasPendingSalesSyncForKey(k)) {
								// Unsent local edits exist — merge instead of blindly overwriting.
								// Mirrors the hasPending branch in reloadSalesMonthsFromServerHard.
								try {
									const localRaw = localStorage.getItem(k);
									const localData = localRaw ? JSON.parse(localRaw) : {};
									const merged = mergeSalesMonthPayloads(localData, v, salesMonth);
									localStorage.setItem(k, JSON.stringify(merged));
									setProtectedSalesPayload(salesMonth, merged);
									queuePendingSalesSync(salesMonth, merged);
								} catch (_mergeErr) { /* keep local data on merge failure */ }
							} else {
								localStorage.setItem(k, JSON.stringify(v));
								setProtectedSalesPayload(salesMonth, v);
								clearPendingSalesSync(salesMonth);
							}
							continue;
						}
						if (isCanonicalExcelMarchMonth(salesMonth)) {
							localStorage.setItem(k, JSON.stringify(v));
							setProtectedSalesPayload(salesMonth, v);
							clearPendingSalesSync(salesMonth);
							continue;
						}
						const existing = getSalesMonthPayload(salesMonth);
						const merged = mergeSalesMonthPayloads(existing, v, salesMonth);
						localStorage.setItem(k, JSON.stringify(merged));
						if (areSalesPayloadsEquivalent(merged, v)) {
							clearPendingSalesSync(salesMonth);
						} else {
							queuePendingSalesSync(salesMonth, merged);
						}
						continue;
					}
					if (hasPendingSalesSyncForKey(k)) continue;
					localStorage.setItem(k, JSON.stringify(v));
				}
				return json.items;
			}
		}
	} catch (_e) { /* fall back to localStorage */ }
	return {};
}

function emitStorageKeyChange(key) {
	if (!key) return;
	try {
		const evt = new StorageEvent('storage', {
			key,
			newValue: localStorage.getItem(key),
			storageArea: localStorage,
			url: window.location.href,
		});
		window.dispatchEvent(evt);
		return;
	} catch (_e) {
		const evt = new Event('storage');
		try { Object.defineProperty(evt, 'key', { value: key }); } catch (_e2) { evt.key = key; }
		window.dispatchEvent(evt);
	}
}

function broadcastRemoteSyncRefresh() {
	const channels = [
		{ name: 'ww_sales_sync', payload: { type: 'sales_updated' } },
		{ name: 'ww_purchase_sync', payload: { type: 'purchase_updated' } },
		{ name: 'ww_accounting_sync', payload: { type: 'accounting_updated' } },
		{ name: 'ww_raw_materials_sync', payload: { type: 'inventory_updated' } },
		{ name: 'ww_finished_products_sync', payload: { type: 'inventory_updated' } },
		{ name: 'ww_equipment_sync', payload: { type: 'inventory_updated' } },
	];
	channels.forEach((entry) => {
		try {
			const bc = new BroadcastChannel(entry.name);
			bc.postMessage(entry.payload);
			bc.close();
		} catch (_e) { /* ignore */ }
	});
}

// Pull factory equipment straight from its dedicated collection endpoint and
// treat the server as authoritative. Used by the live-sync (SSE) refresh so a
// status change on one device updates every other device's dashboard.
async function refreshEquipmentFromServerAuthoritative() {
	try {
		const res = await fetch(API_BASE + '/api/factory-equipment', { credentials: 'include', cache: 'no-store' });
		if (res.ok) {
			const rows = await res.json();
			if (Array.isArray(rows)) {
				localStorage.setItem('ww_equipment', JSON.stringify(rows));
				return rows;
			}
		}
	} catch (_e) { /* keep existing localStorage on failure */ }
	return null;
}

async function pullRemoteDataAndRefreshUi() {
	await loadFromServer('ww_seed_flags');
	await loadFromServer('ww_sales_months');
	const salesMonths = getSalesMonths();
	const salesKeys = salesMonths.map((m) => 'ww_sales_' + m);
	const baseKeys = [
		'ww_raw_materials', 'ww_finished_products', 'ww_production_batches',
		'ww_daily_production', 'ww_purchase_data_v2', 'ww_accounting_data_v2',
		'ww_cost_centre_budgets', 'ww_bom_data', 'ww_equipment', 'ww_market_yearly_values',
	];
	const keysToRefresh = [...baseKeys, ...salesKeys];
	await loadBulkFromServer(keysToRefresh);
	// Equipment lives in its own collection, not the key/value store, so refresh
	// it from the dedicated endpoint before emitting the ww_equipment change.
	await refreshEquipmentFromServerAuthoritative();
	keysToRefresh.forEach((key) => emitStorageKeyChange(key));
	broadcastRemoteSyncRefresh();
}

function formatCurrency(value) {
	return `GH₵${Number(value || 0).toLocaleString(undefined, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

function formatNumber(value) {
	return Number(value || 0).toLocaleString();
}

function formatDateDisplay(dateStr) {
	if (!dateStr) return '—';
	const d = new Date(dateStr + 'T00:00:00');
	if (isNaN(d)) return dateStr;
	return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function statusPillClass(status) {
	const v = String(status || '').toLowerCase();
	if (['paid', 'delivered', 'operational', 'active', 'ready for sale', 'adequate', 'confirmed', 'received'].includes(v)) {
		return 'status-green';
	}
	if (v === 'pending_approval') {
		return 'status-orange';
	}
	if (['pending', 'processing', 'shipped', 'in production', 'low', 'needs_repair', 'needs repair', 'watch'].includes(v)) {
		return 'status-yellow';
	}
	if (['overdue', 'faulty', 'critical', 'faulty_needs_repair', 'inactive', 'delayed'].includes(v)) {
		return 'status-red';
	}
	return 'status-blue';
}

function statusDotClass(status) {
	const v = String(status || '').toLowerCase();
	if (['operational', 'active', 'good'].includes(v)) {
		return 'dot-green';
	}
	if (['needs_repair', 'needs repair', 'watch'].includes(v)) {
		return 'dot-yellow';
	}
	if (['faulty', 'faulty_needs_repair', 'inactive'].includes(v)) {
		return 'dot-red';
	}
	return 'dot-blue';
}

function switchTab(scope, tabName) {
	const allPanels = document.querySelectorAll(`[id^="${scope}-tab-"]`);
	const allButtons = document.querySelectorAll(`button[onclick*="switchTab('${scope}'"]`);

	allPanels.forEach((panel) => panel.classList.remove('tab-active'));
	allButtons.forEach((btn) => btn.classList.remove('tab-active'));

	const nextPanel = document.getElementById(`${scope}-tab-${tabName}`);
	if (nextPanel) {
		nextPanel.classList.add('tab-active');
	}

	allButtons.forEach((btn) => {
		if (btn.getAttribute('data-tab') === tabName) {
			btn.classList.add('tab-active');
		}
	});
}

window.switchTab = switchTab;

function renderProgressBars(container, rows) {
	if (!container) {
		return;
	}
	container.innerHTML = rows.map((row) => {
		return `
			<div class="progress-row">
				<div class="progress-label">${row.label}</div>
				<div class="progress-track"><div class="progress-fill ${row.color || ''}" style="width:${row.value}%"></div></div>
				<div class="progress-val">${row.value}%</div>
			</div>
		`;
	}).join('');
}

function renderVerticalBars(container, rows, config) {
	if (!container) {
		return;
	}

	const maxValue = Math.max(...rows.map((r) => r.value), 1);
	container.innerHTML = `
		<div style="display:flex;align-items:flex-end;gap:10px;height:180px;padding-top:8px;position:relative;">
			${rows.map((r) => {
				const height = Math.max(12, Math.round((r.value / maxValue) * 100));
				const displayVal = config.valueFormatter ? config.valueFormatter(r.value) : r.value;
				return `
					<div class="vbar-col" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;position:relative;cursor:pointer;" data-tooltip="${r.label}: ${displayVal}">
						<div class="vbar-value" style="font-size:11px;color:#64748b;opacity:0;transition:opacity .2s;">${displayVal}</div>
						<div class="vbar-bar" style="width:100%;height:${height}%;max-height:140px;background:${config.color || 'linear-gradient(180deg,#38bdf8,#0077b6)'};border-radius:8px 8px 3px 3px;transition:filter .2s,transform .2s;"></div>
						<div style="font-size:11px;color:#334155;font-weight:600;">${r.label}</div>
					</div>
				`;
			}).join('')}
		</div>
	`;
}

function renderDualBars(container, rows) {
	if (!container) {
		return;
	}
	const maxValue = Math.max(...rows.flatMap((r) => [r.revenue, r.cost]), 1);
	container.innerHTML = rows.map((row) => {
		const revPct = (row.revenue / maxValue) * 100;
		const costPct = (row.cost / maxValue) * 100;
		return `
			<div class="dbar-row" style="margin-bottom:10px;cursor:pointer;padding:6px 8px;border-radius:8px;transition:background .2s;">
				<div style="display:flex;justify-content:space-between;font-size:12px;color:#334155;margin-bottom:5px;"><strong>${row.month}</strong><span class="dbar-detail" style="opacity:0.4;transition:opacity .2s;">${formatCurrency(row.revenue)} / ${formatCurrency(row.cost)}</span></div>
				<div style="display:grid;gap:4px;">
					<div style="height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;"><div class="dbar-fill" style="height:100%;width:${revPct}%;background:linear-gradient(90deg,#16a34a,#22c55e);border-radius:999px;transition:transform .2s;"></div></div>
					<div style="height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;"><div class="dbar-fill" style="height:100%;width:${costPct}%;background:linear-gradient(90deg,#d97706,#f59e0b);border-radius:999px;transition:transform .2s;"></div></div>
				</div>
			</div>
		`;
	}).join('');
}

function renderDashboardCharts(revenueData, dailySales) {
	if (typeof Chart === 'undefined') {
		// Fallback to existing lightweight renderers if Chart.js is unavailable.
		renderDualBars(document.getElementById('chart-rev-cost'), revenueData);
		renderVerticalBars(document.getElementById('chart-daily-sales'), dailySales, {
			color: 'linear-gradient(180deg,#60a5fa,#0077b6)',
			valueFormatter: (v) => formatNumber(v),
		});
		return;
	}

	const revContainer = document.getElementById('chart-rev-cost');
	const salesContainer = document.getElementById('chart-daily-sales');
	if (!revContainer || !salesContainer) {
		return;
	}

	revContainer.innerHTML = '<canvas id="rev-cost-canvas" aria-label="Revenue and Cost trend chart"></canvas>';
	salesContainer.innerHTML = '<canvas id="daily-sales-canvas" aria-label="Daily sales bar chart"></canvas>';

	const revCtx = document.getElementById('rev-cost-canvas');
	const salesCtx = document.getElementById('daily-sales-canvas');
	if (!revCtx || !salesCtx) {
		return;
	}

	if (window.__dashRevCostChart) {
		window.__dashRevCostChart.destroy();
	}
	if (window.__dashDailySalesChart) {
		window.__dashDailySalesChart.destroy();
	}

	window.__dashRevCostChart = new Chart(revCtx, {
		type: 'bar',
		data: {
			labels: revenueData.map((d) => d.month),
			datasets: [
				{
					label: 'Revenue',
					data: revenueData.map((d) => d.revenue),
					borderColor: '#16a34a',
					backgroundColor: 'rgba(22,163,74,0.7)',
					borderWidth: 1,
					minBarLength: 3,
					borderRadius: 6,
				},
				{
					label: 'Costs',
					data: revenueData.map((d) => d.cost),
					borderColor: '#f59e0b',
					backgroundColor: 'rgba(245,158,11,0.7)',
					borderWidth: 1,
					minBarLength: 3,
					borderRadius: 6,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (ctx) => `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}`,
					},
				},
			},
			scales: {
				y: {
					beginAtZero: true,
					ticks: {
						callback: (value) => formatCurrency(value),
					},
				},
			},
		},
	});

	window.__dashDailySalesChart = new Chart(salesCtx, {
		type: 'bar',
		data: {
			labels: dailySales.map((d) => d.label),
			datasets: [
				{
					label: 'Daily Sales (Units)',
					data: dailySales.map((d) => d.value),
					backgroundColor: 'rgba(37,99,235,0.75)',
					borderColor: '#1d4ed8',
					borderWidth: 1,
					minBarLength: 3,
					borderRadius: 6,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (ctx) => `Units: ${formatNumber(ctx.parsed.y)}`,
					},
				},
			},
			scales: {
				y: {
					beginAtZero: true,
					ticks: {
						callback: (value) => formatNumber(value),
					},
				},
			},
		},
	});
}

function renderProfitLossChart(revenueData) {
	const plContainer = document.getElementById('chart-profit-loss');
	const plSummary = document.getElementById('dash-pl-summary');
	if (!plContainer) return;

	const totalRevenue = revenueData.reduce((s, d) => s + d.revenue, 0);
	const totalCost = revenueData.reduce((s, d) => s + d.cost, 0);
	const totalPL = totalRevenue - totalCost;
	const plClass = totalPL >= 0 ? 'color:#22c55e' : 'color:#ef4444';

	if (plSummary) {
		plSummary.innerHTML = `
			<div style="display:flex;flex-direction:column;gap:14px;padding:10px 0;">
				<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#f0fdf4;border-radius:10px;">
					<span style="font-weight:600;color:#334155;">Total Revenue</span>
					<span style="font-weight:700;color:#16a34a;font-size:1.15rem;">${formatCurrency(totalRevenue)}</span>
				</div>
				<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#fef3c7;border-radius:10px;">
					<span style="font-weight:600;color:#334155;">Total Costs</span>
					<span style="font-weight:700;color:#d97706;font-size:1.15rem;">${formatCurrency(totalCost)}</span>
				</div>
				<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:${totalPL >= 0 ? '#f0fdf4' : '#fef2f2'};border-radius:10px;border:2px solid ${totalPL >= 0 ? '#22c55e' : '#ef4444'};">
					<span style="font-weight:700;color:#0f172a;font-size:1.05rem;">${totalPL >= 0 ? 'Net Profit' : 'Net Loss'}</span>
					<span style="font-weight:800;${plClass};font-size:1.3rem;">${formatCurrency(Math.abs(totalPL))}</span>
				</div>
				<div style="font-size:12px;color:#64748b;text-align:center;">Margin: ${totalRevenue > 0 ? ((totalPL / totalRevenue) * 100).toFixed(1) : '0.0'}%</div>
			</div>
		`;
	}

	if (typeof Chart === 'undefined') {
		// Fallback: simple bar rendering
		const maxAbs = Math.max(...revenueData.map((d) => Math.abs(d.profitLoss)), 1);
		plContainer.innerHTML = revenueData.map((row) => {
			const isProfit = row.profitLoss >= 0;
			const pct = (Math.abs(row.profitLoss) / maxAbs) * 100;
			const color = isProfit ? '#22c55e' : '#ef4444';
			return `
				<div style="margin-bottom:8px;padding:6px 8px;border-radius:8px;">
					<div style="display:flex;justify-content:space-between;font-size:12px;color:#334155;margin-bottom:4px;"><strong>${row.month}</strong><span style="color:${color};font-weight:600;">${isProfit ? '+' : ''}${formatCurrency(row.profitLoss)}</span></div>
					<div style="height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${color};border-radius:999px;"></div></div>
				</div>
			`;
		}).join('');
		return;
	}

	plContainer.innerHTML = '<canvas id="pl-canvas" aria-label="Profit and Loss chart"></canvas>';
	const plCtx = document.getElementById('pl-canvas');
	if (!plCtx) return;

	if (window.__dashPLChart) window.__dashPLChart.destroy();

	const plValues = revenueData.map((d) => d.profitLoss);
	const barColors = plValues.map((v) => v >= 0 ? 'rgba(34,197,94,0.75)' : 'rgba(239,68,68,0.75)');
	const borderColors = plValues.map((v) => v >= 0 ? '#16a34a' : '#dc2626');

	window.__dashPLChart = new Chart(plCtx, {
		type: 'bar',
		data: {
			labels: revenueData.map((d) => d.month),
			datasets: [{
				label: 'Profit / Loss',
				data: plValues,
				backgroundColor: barColors,
				borderColor: borderColors,
				borderWidth: 1,
				borderRadius: 6,
			}],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (ctx) => {
							const v = ctx.parsed.y;
							return `${v >= 0 ? 'Profit' : 'Loss'}: ${formatCurrency(Math.abs(v))}`;
						},
					},
				},
			},
			scales: {
				y: {
					ticks: { callback: (value) => formatCurrency(value) },
				},
			},
		},
	});
}

const factoryEquipment = [
	{
		code: 'EQ-101',
		equipment: 'Koyo Packaging Machine #1',
		details: 'with UV, pump, and stainless housing',
		status: 'operational',
		lastMaintenance: '2026-03-18',
		nextMaintenance: '2026-04-18',
	},
	{
		code: 'EQ-102',
		equipment: 'Koyo Packaging Machine #2',
		details: 'with UV, pump, and stainless housing',
		status: 'operational',
		lastMaintenance: '2026-03-17',
		nextMaintenance: '2026-04-17',
	},
	{
		code: 'EQ-103',
		equipment: 'Koyo Packaging Machine #3',
		details: 'with UV, pump, and stainless housing',
		status: 'operational',
		lastMaintenance: '2026-03-16',
		nextMaintenance: '2026-04-16',
	},
	{
		code: 'EQ-104',
		equipment: 'Koyo Packaging Machine #4',
		details: 'with UV, pump, and stainless housing',
		status: 'needs_repair',
		lastMaintenance: '2026-03-09',
		nextMaintenance: '2026-04-09',
	},
	{
		code: 'EQ-105',
		equipment: 'Koyo Packaging Machine #5',
		details: 'with UV, pump, and stainless housing',
		status: 'operational',
		lastMaintenance: '2026-03-14',
		nextMaintenance: '2026-04-14',
	},
	{
		code: 'EQ-106',
		equipment: 'Reverse Osmosis (R/O) Machine',
		details: '4-ton capacity incl. filtration apparatus',
		status: 'operational',
		lastMaintenance: '2026-03-12',
		nextMaintenance: '2026-04-12',
	},
	{
		code: 'EQ-107',
		equipment: 'Reverse Osmosis (R/O) Machine',
		details: '6-ton capacity incl. filtration apparatus',
		status: 'faulty',
		lastMaintenance: '2026-03-05',
		nextMaintenance: '2026-04-05',
	},
];

function getFactoryEquipment() {
	return factoryEquipment;
}

function getEquipmentStatusLabel(status, shortLabel) {
	if (status === 'operational') {
		return 'Operational';
	}
	if (status === 'needs_repair') {
		return shortLabel ? 'Needs Repair (R)' : 'Needs Repair';
	}
	if (status === 'faulty') {
		return 'Faulty';
	}
	if (status === 'faulty_needs_repair') {
		return shortLabel ? 'Faulty + Repair (F + R)' : 'Faulty + Repair';
	}
	return 'Watch';
}

function getEquipmentIssues(status) {
	if (status === 'faulty_needs_repair') {
		return 'F + R';
	}
	if (status === 'faulty') {
		return 'F';
	}
	if (status === 'needs_repair') {
		return 'R';
	}
	return '-';
}

function isEquipmentWarningStatus(status) {
	return ['needs_repair', 'faulty', 'faulty_needs_repair'].includes(status);
}

function getEquipmentWarningNote(status) {
	if (status === 'faulty_needs_repair') {
		return 'Faulty and needs repair';
	}
	if (status === 'faulty') {
		return 'Faulty';
	}
	if (status === 'needs_repair') {
		return 'Needs repair';
	}
	return '';
}

function getEquipmentWarningTone(status) {
	if (status === 'faulty' || status === 'faulty_needs_repair') {
		return 'danger';
	}
	if (status === 'needs_repair') {
		return 'warning';
	}
	return '';
}

function renderEquipmentLabel(eq) {
	const tone = getEquipmentWarningTone(eq.status);
	const warningMarkup = isEquipmentWarningStatus(eq.status)
		? `<span class="equipment-warning-flag ${tone ? `equipment-warning-flag-${tone}` : ''}"><i class="fa-solid fa-triangle-exclamation"></i>${getEquipmentWarningNote(eq.status)}</span>`
		: '';

	return `<span class="equipment-main">${eq.equipment}</span><span class="equipment-sub">${eq.details || ''}</span>${warningMarkup}`;
}

function normalizeRole(role) {
	const value = String(role || '').trim().toLowerCase();
	if (value === 'employee') {
		return 'staff';
	}
	return value;
}

const SPECIAL_ACCESS_EMAIL = 'naanabrenda52@gmail.com';

function resolveEffectiveClientRole(role, email) {
	const normalizedRole = normalizeRole(role);
	const normalizedEmail = String(email || '').trim().toLowerCase();
	if (normalizedEmail === SPECIAL_ACCESS_EMAIL) {
		return 'ceo';
	}
	return normalizedRole;
}

async function resolveCurrentUserRole() {
	if (window.__wwUserRole) {
		return window.__wwUserRole;
	}

	const fromQuery = normalizeRole(new URLSearchParams(window.location.search).get('role'));
	if (fromQuery) {
		localStorage.setItem('ww_user_role', fromQuery);
	}

	try {
		const response = await fetch(API_BASE + '/api/auth/me', { credentials: 'include' });
		if (response.ok) {
			const data = await response.json();
			const apiEmail = String(data?.user?.email || '').trim().toLowerCase();
			if (apiEmail) localStorage.setItem('ww_user_email', apiEmail);
			const apiRole = normalizeRole(data?.user?.effectiveRole || data?.user?.role);
			const effectiveRole = resolveEffectiveClientRole(apiRole, apiEmail);
			if (apiRole) {
				window.__wwUserRole = effectiveRole;
				localStorage.setItem('ww_user_role', effectiveRole);
				return effectiveRole;
			}
		}
	} catch (_error) {
		// Fall back to stored role.
	}

	const storedRole = normalizeRole(localStorage.getItem('ww_user_role'));
	const storedEmail = String(localStorage.getItem('ww_user_email') || '').trim().toLowerCase();
	window.__wwUserRole = resolveEffectiveClientRole(storedRole || 'staff', storedEmail);
	return window.__wwUserRole;
}

// ── Role-Based Access Control ──
const ROLE_PAGE_ACCESS = {
	ceo:        ['dashboard', 'inventory', 'invoices', 'sales', 'vendors', 'accounting', 'vault', 'production', 'reports', 'users'],
	manager:    ['dashboard', 'inventory', 'invoices', 'sales', 'vendors', 'accounting', 'vault', 'production', 'reports', 'users'],
	supervisor: ['inventory', 'invoices', 'sales', 'vendors'],
	staff:      ['inventory', 'invoices', 'sales', 'vendors'],
};

const PAGE_TO_HREF = {
	dashboard: 'dashboard.html',
	inventory: 'inventory.html',
	invoices: 'invoices.html',
	sales: 'sales.html',
	vendors: 'vendors.html',
	accounting: 'accounting.html',
	vault: 'vault.html',
	production: 'production.html',
	reports: 'reports.html',
	users: 'users.html',
};

function resolvePageHref(pageKey) {
	const fileName = PAGE_TO_HREF[pageKey] || 'dashboard.html';
	return window.location.pathname.includes('/pages/') ? fileName : `pages/${fileName}`;
}

function readStoredCanEditDelete() {
	const raw = localStorage.getItem('ww_can_edit_delete');
	if (raw === '1' || raw === 'true') return true;
	if (raw === '0' || raw === 'false') return false;
	return undefined;
}

function canEditDelete(role, explicitPermission = window.__wwCanEditDelete) {
	const normalizedRole = String(role || '').trim().toLowerCase();
	if (normalizedRole === 'ceo' || normalizedRole === 'manager') return true;
	if (typeof explicitPermission === 'boolean') return explicitPermission;
	return normalizedRole === 'supervisor';
}

function enforceRoleAccess() {
	// Resolve role from query string first, then localStorage
	const fromQuery = normalizeRole(new URLSearchParams(window.location.search).get('role'));
	if (fromQuery) {
		localStorage.setItem('ww_user_role', fromQuery);
	}
	const role = fromQuery || normalizeRole(localStorage.getItem('ww_user_role')) || 'staff';
	window.__wwUserRole = role;
	window.__wwCanEditDelete = readStoredCanEditDelete();
	const currentPage = document.body.getAttribute('data-page');
	if (!currentPage) return;

	const allowed = ROLE_PAGE_ACCESS[role] || ROLE_PAGE_ACCESS.staff;

	// Redirect if page not allowed
	if (!allowed.includes(currentPage)) {
		const fallback = allowed[0] || 'dashboard';
		window.location.href = resolvePageHref(fallback);
		return;
	}

	// Hide sidebar links for pages not allowed
	const nav = document.querySelector('.ops-nav');
	if (nav) {
		nav.querySelectorAll('a[href]').forEach((link) => {
			const href = link.getAttribute('href');
			if (href.includes('login') || link.classList.contains('logout-link')) return;
			const pageName = Object.entries(PAGE_TO_HREF).find(([, h]) => href.includes(h));
			if (pageName && !allowed.includes(pageName[0])) {
				link.remove();
			}
		});
	}

	// Hide edit/delete buttons for supervisor & staff
	if (!canEditDelete(role, window.__wwCanEditDelete)) {
		document.querySelectorAll('.btn-edit, .btn-delete, [data-action="edit"], [data-action="delete"]').forEach((btn) => {
			btn.style.display = 'none';
		});

		// Add a class so JS can check permission before showing edit/delete in dynamic content
		document.body.classList.add('role-restricted');
	} else {
		// Important: reverse any previous restriction so buttons don't stay disabled/hidden.
		document.body.classList.remove('role-restricted');
		document.querySelectorAll('.btn-edit, .btn-delete, [data-action="edit"], [data-action="delete"]').forEach((btn) => {
			if (btn.style.display === 'none') btn.style.display = '';
		});
	}

	renderTopbarUserMenu();
}

/* ── Sidebar Collapse Toggle ── */
function initSidebarToggle() {
	const sidebar = document.getElementById('ops-sidebar');
	const brand = sidebar?.querySelector('.sidebar-brand');
	if (!brand) return;

	// Create the expand button (shown when collapsed)
	let expandBtn = document.querySelector('.sidebar-expand-btn');
	if (!expandBtn) {
		expandBtn = document.createElement('button');
		expandBtn.className = 'sidebar-expand-btn';
		expandBtn.title = 'Expand sidebar';
		expandBtn.innerHTML = '<i class="fa-solid fa-bars"></i>';
		document.body.appendChild(expandBtn);
	}

	// Restore previous state
	const storedSidebar = localStorage.getItem('ww_sidebar_collapsed');
	if (storedSidebar === '1') {
		document.body.classList.add('sidebar-collapsed');
	} else if (storedSidebar === null && window.matchMedia('(max-width: 920px)').matches) {
		document.body.classList.add('sidebar-collapsed');
		localStorage.setItem('ww_sidebar_collapsed', '1');
	}

	brand.addEventListener('click', () => {
		document.body.classList.add('sidebar-collapsed');
		localStorage.setItem('ww_sidebar_collapsed', '1');
	});

	expandBtn.addEventListener('click', () => {
		document.body.classList.remove('sidebar-collapsed');
		localStorage.setItem('ww_sidebar_collapsed', '0');
	});
}

function bindLogoutLinks() {
	document.querySelectorAll('.logout-link').forEach((link) => {
		link.addEventListener('click', async (event) => {
			event.preventDefault();
			try {
				await fetch(API_BASE + '/api/auth/logout', { method: 'POST', credentials: 'include' });
			} catch (_error) {
				// Redirect anyway.
			}
			localStorage.removeItem('ww_user_email');
			localStorage.removeItem('ww_user_role');
			localStorage.removeItem('ww_can_edit_delete');
			localStorage.removeItem('ww_user_name');
			window.location.href = window.location.pathname.includes('/pages/') ? '../login.html' : 'login.html';
		});
	});
}

function toRoleLabel(role) {
	const raw = String(role || '').trim();
	if (!raw) return 'User';
	return raw
		.replace(/[_-]+/g, ' ')
		.toLowerCase()
		.replace(/\b\w/g, (m) => m.toUpperCase());
}

function toUserInitials(name, email) {
	const cleanName = String(name || '').trim();
	if (cleanName) {
		const parts = cleanName.split(/\s+/).filter(Boolean);
		if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
		return `${parts[0][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase();
	}
	const localPart = String(email || '').split('@')[0] || 'U';
	return localPart.slice(0, 2).toUpperCase();
}

function getCachedSessionUser() {
	const email = String(localStorage.getItem('ww_user_email') || '').trim().toLowerCase();
	const role = resolveEffectiveClientRole(
		normalizeRole(localStorage.getItem('ww_user_role') || 'staff'),
		email,
	);
	const name = String(localStorage.getItem('ww_user_name') || '').trim();
	const canEditDeleteValue = readStoredCanEditDelete();
	return {
		name: name || 'User',
		email,
		role,
		canEditDelete: canEditDeleteValue,
		roleLabel: toRoleLabel(role),
	};
}

function cacheSessionUser(user) {
	if (!user || typeof user !== 'object') return getCachedSessionUser();
	const email = String(user.email || '').trim().toLowerCase();
	const role = resolveEffectiveClientRole(normalizeRole(user.effectiveRole || user.role || 'staff'), email);
	const name = String(user.name || '').trim() || 'User';
	const canEditDeleteValue = typeof user.canEditDelete === 'boolean'
		? user.canEditDelete
		: readStoredCanEditDelete();
	if (email) localStorage.setItem('ww_user_email', email);
	if (role) localStorage.setItem('ww_user_role', role);
	if (typeof canEditDeleteValue === 'boolean') {
		localStorage.setItem('ww_can_edit_delete', canEditDeleteValue ? '1' : '0');
		window.__wwCanEditDelete = canEditDeleteValue;
	}
	if (name) localStorage.setItem('ww_user_name', name);
	window.__wwCurrentUser = { name, email, role, canEditDelete: canEditDeleteValue, roleLabel: toRoleLabel(role) };
	return window.__wwCurrentUser;
}

function closeTopbarUserMenu() {
	document.querySelectorAll('.ww-user-dropdown.is-open').forEach((menu) => {
		menu.classList.remove('is-open');
		const trigger = menu.querySelector('.ww-user-trigger');
		if (trigger) trigger.setAttribute('aria-expanded', 'false');
	});
}

function openUserManagementPage() {
	window.location.href = resolvePageHref('users');
}

function openTopbarProfileModal(userInput) {
	const user = userInput || window.__wwCurrentUser || getCachedSessionUser();
	const displayName = String(user?.name || 'User').trim() || 'User';
	const roleLabel = toRoleLabel(user?.roleLabel || user?.role || 'User');
	const email = String(user?.email || '').trim() || '—';
	const initials = toUserInitials(displayName, email);

	const existing = document.querySelector('.ww-profile-overlay');
	if (existing) existing.remove();

	const overlay = document.createElement('div');
	overlay.className = 'ww-profile-overlay';
	overlay.innerHTML = `
		<div class="ww-profile-modal" role="dialog" aria-modal="true" aria-label="User Profile">
			<div class="ww-profile-head">
				<h3>Profile</h3>
				<button type="button" class="ww-profile-close" aria-label="Close profile">&times;</button>
			</div>
			<div class="ww-profile-body">
				<div class="ww-profile-summary">
					<span class="ww-profile-avatar">${escapeHtml(initials)}</span>
					<div>
						<p class="ww-profile-name">${escapeHtml(displayName)}</p>
						<p class="ww-profile-role">${escapeHtml(roleLabel)}</p>
					</div>
				</div>
				<div class="ww-profile-list">
					<div class="ww-profile-row"><span class="ww-profile-label">Name</span><span class="ww-profile-value">${escapeHtml(displayName)}</span></div>
					<div class="ww-profile-row"><span class="ww-profile-label">Role</span><span class="ww-profile-value">${escapeHtml(roleLabel)}</span></div>
					<div class="ww-profile-row"><span class="ww-profile-label">Email</span><span class="ww-profile-value">${escapeHtml(email)}</span></div>
				</div>
				<div class="ww-profile-actions">
					<button type="button" class="btn-secondary ww-profile-close-btn">Close</button>
					<button type="button" class="btn-primary ww-profile-users-btn"><i class="fa-solid fa-users-gear"></i> User Management</button>
				</div>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);

	const close = () => {
		const node = document.querySelector('.ww-profile-overlay');
		if (node) node.remove();
	};
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) close();
	});
	overlay.querySelector('.ww-profile-close')?.addEventListener('click', close);
	overlay.querySelector('.ww-profile-close-btn')?.addEventListener('click', close);
	overlay.querySelector('.ww-profile-users-btn')?.addEventListener('click', () => {
		close();
		openUserManagementPage();
	});
}

function renderTopbarUserMenu(userInput) {
	const topbars = document.querySelectorAll('.ops-topbar');
	if (!topbars.length) return;
	const user = userInput || window.__wwCurrentUser || getCachedSessionUser();
	const displayName = String(user?.name || 'User').trim() || 'User';
	const displayRole = toRoleLabel(user?.roleLabel || user?.role || 'user');
	const initials = toUserInitials(displayName, user?.email || '');

	topbars.forEach((topbar) => {
		let menu = topbar.querySelector('.ww-user-dropdown');
		if (!menu) {
			menu = document.createElement('div');
			menu.className = 'ww-user-dropdown';
			menu.innerHTML = `
				<button type="button" class="ww-user-trigger" aria-haspopup="menu" aria-expanded="false" title="Open user menu">
					<span class="ww-user-avatar"></span>
					<span class="ww-user-meta">
						<span class="ww-user-name"></span>
						<span class="ww-user-role"></span>
					</span>
					<i class="fa-solid fa-chevron-down ww-user-caret" aria-hidden="true"></i>
				</button>
				<div class="ww-user-menu" role="menu" aria-label="User menu">
					<button type="button" class="ww-user-menu-item" data-user-action="profile" role="menuitem"><i class="fa-regular fa-user"></i> Profile</button>
					<button type="button" class="ww-user-menu-item" data-user-action="settings" role="menuitem"><i class="fa-solid fa-sliders"></i> Settings</button>
					<button type="button" class="ww-user-menu-item danger" data-user-action="logout" role="menuitem"><i class="fa-solid fa-arrow-right-from-bracket"></i> Log Out</button>
				</div>
			`;
			topbar.appendChild(menu);

			const trigger = menu.querySelector('.ww-user-trigger');
			if (trigger) {
				trigger.addEventListener('click', (event) => {
					event.stopPropagation();
					const isOpen = menu.classList.contains('is-open');
					closeTopbarUserMenu();
					if (!isOpen) {
						menu.classList.add('is-open');
						trigger.setAttribute('aria-expanded', 'true');
					}
				});
			}

			menu.addEventListener('click', async (event) => {
				const actionBtn = event.target.closest('[data-user-action]');
				if (!actionBtn) return;
				const action = actionBtn.getAttribute('data-user-action');
				closeTopbarUserMenu();
				if (action === 'profile') {
					openTopbarProfileModal(window.__wwCurrentUser || getCachedSessionUser());
					return;
				}
				if (action === 'settings') {
					openUserManagementPage();
					return;
				}
				if (action === 'logout') {
					try {
						await fetch(API_BASE + '/api/auth/logout', { method: 'POST', credentials: 'include' });
					} catch (_error) { /* redirect anyway */ }
					localStorage.removeItem('ww_user_email');
					localStorage.removeItem('ww_user_role');
					localStorage.removeItem('ww_can_edit_delete');
					localStorage.removeItem('ww_user_name');
					window.location.href = window.location.pathname.includes('/pages/') ? '../login.html' : 'login.html';
				}
			});
		}

		const avatar = menu.querySelector('.ww-user-avatar');
		const nameEl = menu.querySelector('.ww-user-name');
		const roleEl = menu.querySelector('.ww-user-role');
		if (avatar) avatar.textContent = initials;
		if (nameEl) nameEl.textContent = displayName;
		if (roleEl) roleEl.textContent = displayRole;
	});

	if (!window.__wwUserMenuGlobalBound) {
		window.__wwUserMenuGlobalBound = true;
		document.addEventListener('click', () => closeTopbarUserMenu());
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') closeTopbarUserMenu();
		});
	}
}

function getSystemUsers() {
	try { return JSON.parse(localStorage.getItem('ww_system_users') || '[]'); } catch (_e) { return []; }
}

function saveSystemUsers(users) {
	localStorage.setItem('ww_system_users', JSON.stringify(users));
}

function upsertSystemUser(name, email, role) {
	const normalizedEmail = String(email || '').trim().toLowerCase();
	const users = getSystemUsers();
	const now = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	const existing = users.find((u) => u.email.toLowerCase() === normalizedEmail);
	if (existing) {
		existing.role = role.charAt(0).toUpperCase() + role.slice(1);
		existing.lastLogin = now;
		existing.status = 'Active';
		if (name && name !== existing.name) existing.name = name;
	} else {
		users.push({
			id: 'U' + Date.now(),
			name: name || normalizedEmail.split('@')[0],
			email: normalizedEmail,
			role: role.charAt(0).toUpperCase() + role.slice(1),
			status: 'Active',
			lastLogin: now,
		});
	}
	saveSystemUsers(users);
}

const EYE_CLOSED = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const EYE_OPEN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

function bindPasswordToggles() {
	document.querySelectorAll('.pwd-toggle').forEach((btn) => {
		btn.addEventListener('click', () => {
			const input = btn.parentElement.querySelector('input');
			if (!input) return;
			const visible = input.type === 'text';
			input.type = visible ? 'password' : 'text';
			btn.innerHTML = visible ? EYE_CLOSED : EYE_OPEN;
			btn.classList.toggle('active', !visible);
			btn.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
		});
	});
}

function getRoleLandingPage(role) {
	const ROLE_LANDING = {
		ceo: 'pages/dashboard.html',
		manager: 'pages/dashboard.html',
		supervisor: 'pages/inventory.html',
		staff: 'pages/inventory.html',
	};
	return ROLE_LANDING[role] || 'pages/dashboard.html';
}

function bindRolePersistenceOnAuthForms() {
	// ── Login form ──
	const loginForm = document.getElementById('login-form');
	if (loginForm) {
		loginForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			const formData = new FormData(loginForm);
			const email = String(formData.get('email') || '').trim();
			const password = String(formData.get('password') || '');
			const submitBtn = loginForm.querySelector('button[type="submit"]');

			try {
				if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing in…'; }
				const data = await postJson('/api/auth/login', { email, password });
				const loginEmail = String(data.user?.email || email || '').trim().toLowerCase();
				if (loginEmail) localStorage.setItem('ww_user_email', loginEmail);
				const role = resolveEffectiveClientRole(normalizeRole(data.user?.effectiveRole || data.user?.role), loginEmail);
				localStorage.setItem('ww_user_role', role);
				if (typeof data.user?.canEditDelete === 'boolean') {
					localStorage.setItem('ww_can_edit_delete', data.user.canEditDelete ? '1' : '0');
					window.__wwCanEditDelete = data.user.canEditDelete;
				}
				if (data.user?.name) localStorage.setItem('ww_user_name', String(data.user.name));
				upsertSystemUser(data.user?.name || '', email, role);
				setAuthMessage('Login successful! Redirecting…', false);
				if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Redirecting…'; }
				setTimeout(() => { window.location.href = getRoleLandingPage(role); }, 1000);
			} catch (error) {
				setAuthMessage(error.message || 'Invalid email or password.', true);
				if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Sign In'; }
			}
		});
	}

	// ── Register form ──
	const registerForm = document.getElementById('register-form');
	if (registerForm) {
		registerForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			const formData = new FormData(registerForm);
			const name = String(formData.get('full_name') || '').trim();
			const email = String(formData.get('email') || '').trim();
			const selectedRole = String(formData.get('role') || '');
			const password = String(formData.get('password') || '');
			const confirmPassword = String(formData.get('confirm_password') || '');
			const submitBtn = registerForm.querySelector('button[type="submit"]');

			if (!selectedRole) {
				setAuthMessage('Please select your role.', true);
				return;
			}

			if (password !== confirmPassword) {
				setAuthMessage('Passwords do not match.', true);
				return;
			}

			try {
				if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating account…'; }
				const data = await postJson('/api/auth/register', { name, email, password, role: selectedRole });
				const registerEmail = String(data.user?.email || email || '').trim().toLowerCase();
				if (registerEmail) localStorage.setItem('ww_user_email', registerEmail);
				const role = resolveEffectiveClientRole(normalizeRole(data.user?.effectiveRole || data.user?.role), registerEmail);
				localStorage.setItem('ww_user_role', role);
				if (typeof data.user?.canEditDelete === 'boolean') {
					localStorage.setItem('ww_can_edit_delete', data.user.canEditDelete ? '1' : '0');
					window.__wwCanEditDelete = data.user.canEditDelete;
				}
				if (data.user?.name || name) localStorage.setItem('ww_user_name', String(data.user?.name || name));
				upsertSystemUser(name, email, role);
				setAuthMessage('Account created! Redirecting…', false);
				if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Redirecting…'; }
				setTimeout(() => { window.location.href = getRoleLandingPage(role); }, 1000);
			} catch (error) {
				setAuthMessage(error.message || 'Registration failed.', true);
				if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Account'; }
			}
		});
	}
}

function getTodayDateStr() {
	return new Date().toISOString().slice(0, 10);
}

const PRODUCTION_ZONE_THRESHOLDS = {
	criticalMax: 6000,
	acceptableMax: 11999,
	highPerformanceMin: 12000,
};

const PRODUCTION_ZONE_INFO = {
	critical: {
		label: 'Critical Zone',
		colorClass: 'zone-critical',
		badgeClass: 'badge-red',
		band: 'rgba(239, 68, 68, 0.08)',
		text: 'Immediate management intervention required',
	},
	acceptable: {
		label: 'Acceptable Zone',
		colorClass: 'zone-acceptable',
		badgeClass: 'badge-yellow',
		band: 'rgba(245, 158, 11, 0.08)',
		text: 'Stable operations, room for improvement',
	},
	high: {
		label: 'High-Performance Zone',
		colorClass: 'zone-high',
		badgeClass: 'badge-green',
		band: 'rgba(34, 197, 94, 0.08)',
		text: 'Target achieved or exceeded',
	},
};

function getProductionZoneInfo(output) {
	const value = Number(output || 0);
	if (value <= PRODUCTION_ZONE_THRESHOLDS.criticalMax) return { key: 'critical', output: value, ...PRODUCTION_ZONE_INFO.critical };
	if (value <= PRODUCTION_ZONE_THRESHOLDS.acceptableMax) return { key: 'acceptable', output: value, ...PRODUCTION_ZONE_INFO.acceptable };
	return { key: 'high', output: value, ...PRODUCTION_ZONE_INFO.high };
}

function getInvoiceOutputBags(invoice) {
	if (!invoice || typeof invoice !== 'object') return 0;
	if (Array.isArray(invoice.items) && invoice.items.length) {
		return invoice.items.reduce((sum, item) => sum + (Number(item && item.qty) || 0), 0);
	}
	return Number(invoice.bags || 0) || 0;
}

function getProductionOutputForDate(dateKey) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return 0;
	const salesData = getAllSalesData();
	const invoices = Array.isArray(salesData && salesData.invoices) ? salesData.invoices : [];
	return invoices.reduce((sum, invoice) => {
		if (!invoice || !invoice.id) return sum;
		const invoiceDate = String(invoice.date || '').slice(0, 10);
		if (invoiceDate !== dateKey) return sum;
		return sum + getInvoiceOutputBags(invoice);
	}, 0);
}

function getTodayProductionZone() {
	const todayStr = getTodayDateStr();
	return getProductionZoneInfo(getProductionOutputForDate(todayStr));
}

function loadFinishedProductsFromStorage() {
	try {
		return JSON.parse(localStorage.getItem('ww_finished_products') || '[]');
	} catch (_e) {
		return [];
	}
}

function saveFinishedProductsToStorage(products) {
	localStorage.setItem('ww_finished_products', JSON.stringify(products));
	syncToServer('ww_finished_products', products);
	rebuildDailyProductionLog(products);
	// Broadcast instantly to any open inventory/dashboard tab
	try {
		const bc = new BroadcastChannel('ww_finished_products_sync');
		bc.postMessage({ type: 'finished_products_updated' });
		bc.close();
	} catch (_e) { /* BroadcastChannel not supported — storage event is the fallback */ }
}

function rebuildDailyProductionLog(products) {
	const log = {};
	products.forEach((p) => {
		const date = p.addedDate || getTodayDateStr();
		log[date] = (log[date] || 0) + Number(p.qty || 0);
	});
	localStorage.setItem('ww_daily_production', JSON.stringify(log));
	syncToServer('ww_daily_production', log);
}

function getDailyProductionLog() {
	try {
		return JSON.parse(localStorage.getItem('ww_daily_production') || '{}');
	} catch (_e) {
		return {};
	}
}

function loadRawMaterialsFromStorage() {
	try {
		return JSON.parse(localStorage.getItem('ww_raw_materials') || '[]');
	} catch (_e) {
		return [];
	}
}

function saveRawMaterialsToStorage(materials) {
	localStorage.setItem('ww_raw_materials', JSON.stringify(materials));
	syncToServer('ww_raw_materials', materials);
	// Broadcast instantly to any open dashboard/inventory tab
	try {
		const bc = new BroadcastChannel('ww_raw_materials_sync');
		bc.postMessage({ type: 'raw_materials_updated' });
		bc.close();
	} catch (_e) { /* BroadcastChannel not supported — storage event is the fallback */ }
}

function loadEquipmentFromStorage() {
	try {
		const stored = JSON.parse(localStorage.getItem('ww_equipment') || '[]');
		if (Array.isArray(stored) && stored.length) {
			return stored;
		}
	} catch (_e) {
		// Fall through to defaults.
	}
	return getFactoryEquipment().map((eq) => ({ ...eq }));
}

async function fetchEquipmentFromServer() {
	try {
		const res = await fetch(API_BASE + '/api/factory-equipment', { credentials: 'include', cache: 'no-store' });
		if (res.ok) {
			const rows = await res.json();
			if (Array.isArray(rows) && rows.length) {
				// Server is always the source of truth — it holds the latest saved state
				// for ALL fields (status, name, details, maintenance dates).
				// We used to merge local status over server status here, but that was
				// backwards: it meant dashboard status changes got silently rolled back
				// to whatever was in the local cache.
				localStorage.setItem('ww_equipment', JSON.stringify(rows));
				return rows;
			}
		}
	} catch (_e) { /* fall back to localStorage */ }
	return loadEquipmentFromStorage();
}

function saveEquipmentToStorage(equipmentRows) {
	localStorage.setItem('ww_equipment', JSON.stringify(equipmentRows));
	// Broadcast instantly to any open dashboard/inventory tab
	try {
		const bc = new BroadcastChannel('ww_equipment_sync');
		bc.postMessage({ type: 'equipment_updated' });
		bc.close();
	} catch (_e) { /* BroadcastChannel not supported — storage event is the fallback */ }
}

async function saveOneEquipmentToServer(eq) {
	if (!eq) return false;
	if (!eq.id) {
		showDeleteToast('Equipment item is missing a server ID. Refreshing equipment data...');
		await fetchEquipmentFromServer();
		return false;
	}
	try {
		const res = await fetch(API_BASE + '/api/factory-equipment/' + eq.id, {
			method: 'PUT', credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				status: eq.status,
				equipment: eq.equipment,
				details: eq.details,
				lastMaintenance: eq.lastMaintenance,
				nextMaintenance: eq.nextMaintenance,
			}),
		});
		if (!res.ok) {
			showDeleteToast('Equipment save failed — please refresh and try again.');
			return false;
		}
		return true;
	} catch (_err) {
		showDeleteToast('Could not reach server to save equipment changes.');
		return false;
	}
}

function calcWeeklyEfficiencyLabel(dailyLog, todayStr) {
	const oneDayMs = 86400000;
	const today = new Date(`${todayStr}T00:00:00`);

	const weekValues = [];
	const previousWeekValues = [];
	for (let i = 6; i >= 0; i -= 1) {
		const currentDate = new Date(today.getTime() - (i * oneDayMs));
		const previousDate = new Date(today.getTime() - ((i + 7) * oneDayMs));
		const currentKey = currentDate.toISOString().slice(0, 10);
		const previousKey = previousDate.toISOString().slice(0, 10);
		weekValues.push(Number(dailyLog[currentKey] || 0));
		previousWeekValues.push(Number(dailyLog[previousKey] || 0));
	}

	const currentWeekTotal = weekValues.reduce((sum, value) => sum + value, 0);
	const previousWeekTotal = previousWeekValues.reduce((sum, value) => sum + value, 0);

	let streakImprovedDays = 0;
	for (let i = 1; i < weekValues.length; i += 1) {
		if (weekValues[i] >= weekValues[i - 1]) {
			streakImprovedDays += 1;
		}
	}
	const streakPercent = Math.round((streakImprovedDays / 6) * 100);

	if (previousWeekTotal === 0) {
		if (currentWeekTotal === 0) {
			return 'No weekly production data yet';
		}
		return `${formatNumber(currentWeekTotal)} units this week • ${streakPercent}% weekly streak`;
	}

	const change = ((currentWeekTotal - previousWeekTotal) / previousWeekTotal) * 100;
	const sign = change >= 0 ? '+' : '';
	const trendText = change >= 0 ? 'going well' : 'not going well';
	return `${sign}${change.toFixed(1)}% vs last week • ${streakPercent}% weekly streak (${trendText})`;
}

async function initDashboardPage() {
	if (document.body.getAttribute('data-page') !== 'dashboard') {
		return;
	}
	await clearSalesBrowserCacheIfServerEmpty();

	const dashTraceEnabled = (() => {
		try {
			const q = new URLSearchParams(window.location.search);
			if (q.get('traceInv') === '1') localStorage.setItem('ww_trace_inventory', '1');
			if (q.get('traceInv') === '0') localStorage.removeItem('ww_trace_inventory');
			return localStorage.getItem('ww_trace_inventory') === '1';
		} catch (_e) {
			return false;
		}
	})();

	const dashTrace = (event, details) => {
		if (!dashTraceEnabled) return;
		const payload = details && typeof details === 'object' ? details : {};
		try {
			console.log('[DASH-TRACE]', new Date().toISOString(), event, payload);
		} catch (_e) { /* no-op */ }
	};

	dashTrace('init:start', { path: window.location.pathname, search: window.location.search });

	let selectedDashboardYear = null;
	const parseYearFromDateLike = (raw) => {
		const text = String(raw || '').trim();
		if (!text) return null;
		const iso = /^(\d{4})-(\d{2})/.exec(text);
		if (iso) return Number(iso[1]);
		const dt = new Date(text);
		if (isNaN(dt)) return null;
		return dt.getFullYear();
	};
	const isDateInSelectedDashboardYear = (raw) => {
		if (!selectedDashboardYear) return true;
		const y = parseYearFromDateLike(raw);
		return y === selectedDashboardYear;
	};
	const collectDashboardYears = () => {
		const years = new Set();
		recoverSalesMonthsFromStorage().forEach((month) => {
			if (/^\d{4}-\d{2}$/.test(month)) years.add(Number(month.slice(0, 4)));
		});
		const salesData = getAllSalesData();
		salesData.invoices.forEach((inv) => {
			const y = parseYearFromDateLike(inv.date);
			if (Number.isFinite(y)) years.add(y);
		});
		salesData.salesOrders.forEach((ord) => {
			const y = parseYearFromDateLike(ord.orderDate);
			if (Number.isFinite(y)) years.add(y);
		});
		try {
			const batches = JSON.parse(localStorage.getItem('ww_production_batches') || '[]');
			(batches || []).forEach((batch) => {
				const y = parseYearFromDateLike(batch.date || batch.addedDate);
				if (Number.isFinite(y)) years.add(y);
			});
		} catch (_e) { /* ignore */ }
		try {
			const accounting = JSON.parse(localStorage.getItem('ww_accounting_data_v2') || 'null');
			if (accounting && typeof accounting === 'object') {
				['ledger', 'cashbook', 'salaries', 'assets'].forEach((bucket) => {
					(accounting[bucket] || []).forEach((entry) => {
						const y = parseYearFromDateLike(entry.date || entry.month || entry.week);
						if (Number.isFinite(y)) years.add(y);
					});
				});
			}
		} catch (_e) { /* ignore */ }
		try {
			const purchase = JSON.parse(localStorage.getItem('ww_purchase_data_v2') || 'null');
			if (purchase && Array.isArray(purchase.purchaseOrders)) {
				purchase.purchaseOrders.forEach((po) => {
					const y = parseYearFromDateLike(po.date || po.expectedDate);
					if (Number.isFinite(y)) years.add(y);
				});
			}
		} catch (_e) { /* ignore */ }
		Object.keys(getDailyProductionLog()).forEach((dayKey) => {
			const y = parseYearFromDateLike(dayKey);
			if (Number.isFinite(y)) years.add(y);
		});
		if (years.size === 0) years.add(new Date().getFullYear());
		return Array.from(years).sort((a, b) => a - b);
	};

	// ── Build revenue/cost chart from sales + production + accounting data ──
	const buildRevenueData = () => {
		const salesData = getAllSalesData();
		const batches = JSON.parse(localStorage.getItem('ww_production_batches') || '[]');
		const purchaseData = JSON.parse(localStorage.getItem('ww_purchase_data_v2') || 'null');
		const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const byMonth = {};
		const ensureMonth = (key) => { if (!byMonth[key]) byMonth[key] = { revenue: 0, cost: 0 }; };
		const monthKeyFromDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

		// Revenue from invoices (paid only — consistent with Sales & Accounting pages)
		for (const inv of salesData.invoices) {
			if (inv.status !== 'paid') continue;
			const d = new Date(inv.date);
			if (isNaN(d)) continue;
			if (selectedDashboardYear && d.getFullYear() !== selectedDashboardYear) continue;
			const key = monthKeyFromDate(d);
			ensureMonth(key);
			byMonth[key].revenue += Number(inv.amount) || 0;
		}

		// Keep active sales months visible on the chart even when revenue is pending.
		for (const month of recoverSalesMonthsFromStorage()) {
			if (!/^\d{4}-\d{2}$/.test(month)) continue;
			if (selectedDashboardYear && Number(month.slice(0, 4)) !== selectedDashboardYear) continue;
			ensureMonth(month);
		}
		// (Sales orders mirror invoices — skip to avoid double-counting)
		// Production batch costs
		for (const b of batches) {
			const d = new Date(b.date);
			if (isNaN(d)) continue;
			if (selectedDashboardYear && d.getFullYear() !== selectedDashboardYear) continue;
			const key = monthKeyFromDate(d);
			ensureMonth(key);
			byMonth[key].cost += Number(b.cost) || 0;
		}
		// Accounting ledger expenses (operational costs, salaries mirrored to ledger)
		let acctData;
		try { acctData = JSON.parse(localStorage.getItem('ww_accounting_data_v2') || 'null'); } catch (_) { acctData = null; }
		if (acctData) {
			const expenseAccounts = ['Transport', 'Production', 'Maintenance', 'Utilities', 'Administration', 'Marketing', 'Salaries', 'Salaries & Wages'];
			for (const entry of (acctData.ledger || [])) {
				if (String(entry.desc || '').toLowerCase().includes('audit temp entry')) continue;
				if (!expenseAccounts.includes(entry.account)) continue;
				const d = new Date(entry.date);
				if (isNaN(d)) continue;
				if (selectedDashboardYear && d.getFullYear() !== selectedDashboardYear) continue;
				const key = monthKeyFromDate(d);
				ensureMonth(key);
				byMonth[key].cost += Number(entry.debit || entry.amount) || 0;
			}
		}

		// Purchase orders are operational cost drivers for the same dashboard period.
		if (purchaseData && Array.isArray(purchaseData.purchaseOrders)) {
			for (const po of purchaseData.purchaseOrders) {
				const d = new Date(po.date || po.expectedDate);
				if (isNaN(d)) continue;
				if (selectedDashboardYear && d.getFullYear() !== selectedDashboardYear) continue;
				const key = monthKeyFromDate(d);
				ensureMonth(key);
				const poAmount = Array.isArray(po.items) && po.items.length
					? po.items.reduce((sum, item) => sum + ((Number(item.qty) || 0) * (Number(item.unitCost) || 0)), 0)
					: (Number(po.amount) || 0);
				byMonth[key].cost += poAmount;
			}
		}

		const keys = Object.keys(byMonth).sort();
		return keys.map((key) => {
			const [year, month] = key.split('-');
			const mIdx = parseInt(month, 10) - 1;
			const pl = byMonth[key].revenue - byMonth[key].cost;
			const label = `${monthNames[mIdx]} ${year}`;
			return { month: label, revenue: byMonth[key].revenue, cost: byMonth[key].cost, profitLoss: pl };
		});
	};

	// ── Build daily sales from last 7 days of sales data ──
	const buildDailySales = () => {
		const salesData = getAllSalesData();
		const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const now = new Date();
		const buckets = {};
		for (let i = 6; i >= 0; i--) {
			const d = new Date(now);
			d.setDate(d.getDate() - i);
			const key = d.toISOString().slice(0, 10);
			buckets[key] = { label: dayLabels[d.getDay()], value: 0 };
		}
		for (const inv of salesData.invoices) {
			const d = new Date(inv.date);
			if (isNaN(d)) continue;
			if (selectedDashboardYear && d.getFullYear() !== selectedDashboardYear) continue;
			const key = d.toISOString().slice(0, 10);
			if (buckets[key]) {
				buckets[key].value += (inv.items || []).reduce((s, it) => s + it.qty, 0);
			}
		}

		let rows = Object.values(buckets);
		const hasActivity = rows.some((r) => r.value > 0);
		if (hasActivity) return rows;

		// If there is no activity in the last 7 calendar days, show the latest 7 active sales days.
		const activeMap = {};
		for (const inv of salesData.invoices) {
			const d = new Date(inv.date);
			if (isNaN(d)) continue;
			if (selectedDashboardYear && d.getFullYear() !== selectedDashboardYear) continue;
			const key = d.toISOString().slice(0, 10);
			const units = (inv.items || []).reduce((s, it) => s + (Number(it.qty) || 0), 0);
			activeMap[key] = (activeMap[key] || 0) + units;
		}

		const activeKeys = Object.keys(activeMap).sort().slice(-7);
		if (!activeKeys.length) return rows;

		rows = activeKeys.map((key) => {
			const d = new Date(key + 'T00:00:00');
			return { label: dayLabels[d.getDay()], value: activeMap[key] || 0 };
		});
		return rows;
	};

	// ── Count active customers (appearing more than 5 times) from sales data ──
	const countActiveCustomers = () => {
		const salesData = getAllSalesData();
		const counts = {};
		salesData.invoices.forEach((inv) => {
			const d = new Date(inv.date);
			if (selectedDashboardYear && (!isNaN(d) ? d.getFullYear() !== selectedDashboardYear : true)) return;
			if (inv.customer) { const k = inv.customer.toLowerCase().trim(); counts[k] = (counts[k] || 0) + 1; }
		});
		salesData.salesOrders.forEach((ord) => {
			const d = new Date(ord.orderDate);
			if (selectedDashboardYear && (!isNaN(d) ? d.getFullYear() !== selectedDashboardYear : true)) return;
			if (ord.customer) { const k = ord.customer.toLowerCase().trim(); counts[k] = (counts[k] || 0) + 1; }
		});
		return Object.values(counts).filter((c) => c > 5).length;
	};

	const renderDashboardYearSelector = () => {
		const yearBar = document.getElementById('dash-year-selector-bar');
		const yearSelect = document.getElementById('dash-year-select');
		if (!yearBar || !yearSelect) return;
		const years = collectDashboardYears();
		const shouldShowSelector = years.length > 1;
		if (!shouldShowSelector) {
			yearBar.style.display = 'none';
			selectedDashboardYear = null;
			return;
		}
		yearBar.style.display = 'flex';
		if (!selectedDashboardYear || !years.includes(selectedDashboardYear)) {
			const currentYear = new Date().getFullYear();
			selectedDashboardYear = years.includes(currentYear) ? currentYear : years[years.length - 1];
		}
		yearSelect.innerHTML = [...years].sort((a, b) => b - a).map((year) => `<option value="${year}">${year}</option>`).join('');
		yearSelect.value = String(selectedDashboardYear);
		if (!yearSelect.dataset.bound) {
			yearSelect.dataset.bound = '1';
			yearSelect.addEventListener('change', () => {
				const next = Number(yearSelect.value);
				selectedDashboardYear = Number.isFinite(next) ? next : null;
				refreshDashboardView();
			});
		}
	};

	const buildInvoiceRevenueByMonth = () => {
		const salesData = getAllSalesData();
		const byMonth = {};
		for (const inv of salesData.invoices) {
			if (inv.status !== 'paid') continue;
			const d = new Date(inv.date);
			if (isNaN(d)) continue;
			const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
			byMonth[key] = (byMonth[key] || 0) + (Number(inv.amount) || 0);
		}
		return Object.keys(byMonth).sort().map((key) => {
			const [year, month] = key.split('-');
			return {
				key,
				year: Number(year),
				month: Number(month),
				value: byMonth[key],
			};
		});
	};

	const parseYearlyMarketValues = (raw) => {
		const rows = [];
		if (!raw) return rows;

		if (Array.isArray(raw)) {
			for (const item of raw) {
				const year = Number(item && (item.year ?? item.period ?? item.label));
				const value = Number(item && (item.value ?? item.amount ?? item.total ?? item.revenue));
				if (Number.isFinite(year) && Number.isFinite(value)) rows.push({ year, value });
			}
		} else if (typeof raw === 'object') {
			for (const [yearKey, valueRaw] of Object.entries(raw)) {
				const year = Number(yearKey);
				const value = Number(valueRaw);
				if (Number.isFinite(year) && Number.isFinite(value)) rows.push({ year, value });
			}
		}

		return rows.sort((a, b) => a.year - b.year);
	};

	const getExplicitYearlyMarketValues = () => {
		try {
			const raw = JSON.parse(localStorage.getItem('ww_market_yearly_values') || 'null');
			return parseYearlyMarketValues(raw);
		} catch (_e) {
			return [];
		}
	};

	const calculateMarketGrowthRate = () => {
		const explicitYearly = getExplicitYearlyMarketValues();
		if (explicitYearly.length >= 2) {
			const current = explicitYearly[explicitYearly.length - 1];
			const previous = explicitYearly[explicitYearly.length - 2];
			if (previous.value > 0 && current.value > 0) {
				const growth = ((current.value - previous.value) / previous.value) * 100;
				return {
					value: growth,
					label: `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`,
					meta: `${current.year} vs ${previous.year} from yearly values`,
					color: growth >= 0 ? 'green' : 'red',
				};
			}
		}

		const monthlyRevenue = buildInvoiceRevenueByMonth();
		const yearlyFromMonthly = monthlyRevenue.reduce((acc, row) => {
			acc[row.year] = (acc[row.year] || 0) + row.value;
			return acc;
		}, {});
		const derivedYears = Object.keys(yearlyFromMonthly).map(Number).sort((a, b) => a - b);

		if (derivedYears.length >= 2) {
			const currentYear = derivedYears[derivedYears.length - 1];
			const previousYear = derivedYears[derivedYears.length - 2];
			const currentValue = yearlyFromMonthly[currentYear] || 0;
			const previousValue = yearlyFromMonthly[previousYear] || 0;
			if (previousValue > 0 && currentValue > 0) {
				const growth = ((currentValue - previousValue) / previousValue) * 100;
				return {
					value: growth,
					label: `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`,
					meta: `${currentYear} vs ${previousYear} derived from monthly values`,
					color: growth >= 0 ? 'green' : 'red',
				};
			}
		}

		if (monthlyRevenue.length >= 2) {
			const current = monthlyRevenue[monthlyRevenue.length - 1];
			const previous = monthlyRevenue[monthlyRevenue.length - 2];
			if (previous.value > 0 && current.value > 0) {
				const growth = ((current.value - previous.value) / previous.value) * 100;
				return {
					value: growth,
					label: `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`,
					meta: `${current.key} vs ${previous.key} monthly fallback`,
					color: growth >= 0 ? 'green' : 'red',
				};
			}
		}

		return {
			value: null,
			label: 'N/A',
			meta: 'Need at least two periods with previous value > 0',
			color: 'yellow',
		};
	};

	let equipmentStatus = loadEquipmentFromStorage();
	dashTrace('equipment:cache-load', { count: Array.isArray(equipmentStatus) ? equipmentStatus.length : -1 });

	// Fetch fresh equipment from server and re-render when ready
	fetchEquipmentFromServer().then((serverEquipment) => {
		equipmentStatus = serverEquipment;
		dashTrace('equipment:fetch:done', { count: Array.isArray(serverEquipment) ? serverEquipment.length : -1 });
		renderDashboardEquipmentStatus();
	});

	const buildStockAlerts = () => {
		const liveRawMaterials = loadRawMaterialsFromStorage();
		if (liveRawMaterials.length) {
			return liveRawMaterials.map((m) => ({
				item: m.material || 'Raw Material',
				current: Number(m.quantity || 0),
				min: Number(m.minLevel || 0),
			}));
		}
		return [];
	};

	const renderDashboardLiveSummary = () => {
		const dailyLog = getDailyProductionLog();
		const todayStr = getTodayDateStr();
		const batchLog = (() => {
			try {
				return JSON.parse(localStorage.getItem('ww_production_batches') || '[]').reduce((acc, batch) => {
					const dateKey = batch.date || batch.addedDate;
					if (!dateKey) return acc;
					acc[dateKey] = (acc[dateKey] || 0) + Number(batch.qty || 0);
					return acc;
				}, {});
			} catch (_e) {
				return {};
			}
		})();
		const productionLogAll = Object.keys(dailyLog).length ? dailyLog : batchLog;
		const productionLog = Object.entries(productionLogAll).reduce((acc, [dateKey, qty]) => {
			if (!isDateInSelectedDashboardYear(dateKey)) return acc;
			acc[dateKey] = qty;
			return acc;
		}, {});
		const finishedProductsFallback = (() => {
			try {
				return JSON.parse(localStorage.getItem('ww_finished_products') || '[]').reduce((sum, item) => {
					if (!isDateInSelectedDashboardYear(item.date || item.addedDate)) return sum;
					return sum + (Number(item.qty) || 0);
				}, 0);
			} catch (_e) {
				return 0;
			}
		})();
		const logUnitsProduced = Object.values(productionLog).reduce((sum, value) => sum + (Number(value) || 0), 0);
		const totalUnitsProduced = logUnitsProduced > 0 ? logUnitsProduced : finishedProductsFallback;
		const unitsProducedToday = Number(productionLog[todayStr] || 0);
		const stockAlerts = buildStockAlerts();
		const stockAlertCount = stockAlerts.filter((a) => a.current < a.min).length;
		const stockCriticalCount = stockAlerts.filter((a) => a.current < a.min * 0.5).length;

		const salesData = getAllSalesData();
		const hasInvoiceData = salesData.invoices.some((invoice) => Number(invoice?.amount || 0) > 0);
		const revenueData = buildRevenueData();
		const totalRevenue = hasInvoiceData ? salesData.invoices.reduce((sum, invoice) => {
			if (!isDateInSelectedDashboardYear(invoice.date)) return sum;
			return invoice.status === 'paid' ? sum + (Number(invoice.amount) || 0) : sum;
		}, 0) : 0;
		const promoExpense = hasInvoiceData ? salesData.invoices.reduce((sum, invoice) => {
			if (!isDateInSelectedDashboardYear(invoice.date) || invoice.status !== 'paid') return sum;
			const rate = Number(invoice.rate || (invoice.items && invoice.items[0] ? invoice.items[0].unitPrice : 0) || 0);
			return sum + (Number(invoice.promo || 0) * rate);
		}, 0) : 0;
		const revenueMtd = revenueData.length > 0 ? revenueData[revenueData.length - 1].revenue : 0;
		const prevRevenue = revenueData.length > 1 ? revenueData[revenueData.length - 2].revenue : 0;
		const revChange = prevRevenue > 0 ? (((revenueMtd - prevRevenue) / prevRevenue) * 100).toFixed(1) : 0;
		const marketGrowth = hasInvoiceData ? calculateMarketGrowthRate() : {
			value: null,
			label: 'N/A',
			meta: 'No sales data yet',
			color: 'yellow',
		};
		const isCurrentYearView = !selectedDashboardYear || selectedDashboardYear === new Date().getFullYear();
		const unitsMeta = totalUnitsProduced > 0
			? (isCurrentYearView
				? `${formatNumber(unitsProducedToday)} produced today • ${calcWeeklyEfficiencyLabel(productionLog, todayStr)}`
				: `${formatNumber(totalUnitsProduced)} units in ${selectedDashboardYear}`)
			: 'No production data yet';

		const activeCustomers = countActiveCustomers();
		const todayPerformanceZone = getTodayProductionZone();

		const kpiCards = [
			{ icon: '<i class="fa-solid fa-cedi-sign"></i>', label: 'Total Revenue', value: formatCurrency(totalRevenue), meta: revenueMtd > 0 ? `${formatCurrency(revenueMtd)} latest month • ${revChange >= 0 ? '+' : ''}${revChange}% vs previous month` : 'No sales data yet', subMeta: hasInvoiceData && promoExpense > 0 ? `<span>Gross sales — promo booked as expense</span><span>Promo cost: ${formatCurrency(promoExpense)} (see Accounting)</span>` : '', color: 'blue', link: null },
			{ icon: '<i class="fa-solid fa-chart-line"></i>', label: 'Market Growth Rate', value: marketGrowth.label, meta: marketGrowth.meta, color: marketGrowth.color, link: null },
			{ icon: '<i class="fa-solid fa-box"></i>', label: 'Units Produced', value: formatNumber(totalUnitsProduced), meta: unitsMeta, color: 'green', link: null },
			{ icon: '<i class="fa-solid fa-industry"></i>', label: 'Daily Output', value: formatNumber(todayPerformanceZone.output), subtitle: 'bags/day', meta: `<span class="today-performance-badge ${todayPerformanceZone.badgeClass}">${todayPerformanceZone.label}</span><span>${todayPerformanceZone.text}</span>`, subMeta: `<span>Daily output: <strong>${formatNumber(todayPerformanceZone.output)}</strong> bags</span>`, color: todayPerformanceZone.key === 'critical' ? 'red' : todayPerformanceZone.key === 'acceptable' ? 'yellow' : 'green', link: null },
			{ icon: '<i class="fa-solid fa-users"></i>', label: 'Active Customers', value: formatNumber(activeCustomers), meta: activeCustomers > 0 ? 'Unique customers from sales' : 'No customers yet', color: 'purple', link: null },
			{ icon: '<i class="fa-solid fa-triangle-exclamation"></i>', label: 'Stock Alerts', value: String(stockAlertCount), meta: `${stockCriticalCount} critically low \u2014 needs reorder`, color: stockCriticalCount > 0 ? 'red' : 'yellow', link: `${resolvePageHref('inventory')}?tab=materials` },
		];

		// Fetch online store stats (non-blocking) with cache/throttle so dashboard refresh stays snappy.
		const applyOnlineStatsToDashboard = (stats) => {
			if (!stats) return;
			const onlineKpi = document.getElementById('kpi-online-orders');
			if (onlineKpi) {
				onlineKpi.querySelector('.kpi-value').textContent = String(stats.pendingOrders);
				onlineKpi.querySelector('.kpi-meta').textContent = `${stats.orderCount} total · ${stats.customerCount} customers`;
				const iconWrap = onlineKpi.querySelector('.kpi-icon-square');
				if (iconWrap) {
					iconWrap.classList.remove('red', 'green');
					iconWrap.classList.add(stats.pendingOrders > 0 ? 'red' : 'green');
				}
				return;
			}

			const kpiGrid = document.getElementById('dash-kpi-grid');
			if (!kpiGrid) return;
			const card = document.createElement('article');
			card.className = 'kpi-card-dashboard kpi-card-link';
			card.id = 'kpi-online-orders';
			card.setAttribute('role', 'link');
			card.setAttribute('tabindex', '0');
			card.setAttribute('data-kpi-link', 'invoices.html');
			card.style.cursor = 'pointer';
			card.innerHTML = `
				<div class="kpi-head">
					<div>
						<p class="kpi-label">Online Orders</p>
						<p class="kpi-value">${stats.pendingOrders}</p>
					</div>
					<div class="kpi-icon-square ${stats.pendingOrders > 0 ? 'red' : 'green'}"><i class="fa-solid fa-globe"></i></div>
				</div>
				<p class="kpi-meta">${stats.orderCount} total · ${stats.customerCount} customers</p>
			`;
			card.addEventListener('click', () => { window.location.href = resolvePageHref('invoices'); });
			kpiGrid.appendChild(card);
		};

		if (window.__wwDashboardOnlineStats) {
			Promise.resolve().then(() => applyOnlineStatsToDashboard(window.__wwDashboardOnlineStats));
		}
		const nowMs = Date.now();
		const lastFetchMs = Number(window.__wwDashboardOnlineStatsFetchedAt || 0);
		if (!window.__wwDashboardOnlineStatsInFlight && (nowMs - lastFetchMs > 15000)) {
			window.__wwDashboardOnlineStatsInFlight = true;
			const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
			const timeoutId = setTimeout(() => {
				if (controller) controller.abort();
			}, 5000);
			fetch(API_BASE + '/api/store/admin/stats', {
				cache: 'no-store',
				signal: controller ? controller.signal : undefined,
			}).then((r) => r.ok ? r.json() : null).then((stats) => {
				if (!stats) return;
				window.__wwDashboardOnlineStats = stats;
				window.__wwDashboardOnlineStatsFetchedAt = Date.now();
				applyOnlineStatsToDashboard(stats);
			}).catch(() => {
				/* keep dashboard responsive even if online stats API is slow */
			}).finally(() => {
				clearTimeout(timeoutId);
				window.__wwDashboardOnlineStatsInFlight = false;
			});
		}

		const kpiGrid = document.getElementById('dash-kpi-grid');
		if (kpiGrid) {
			kpiGrid.innerHTML = kpiCards.map((kpi) => {
				const linkProps = kpi.link ? `role="link" tabindex="0" data-kpi-link="${kpi.link}" style="cursor:pointer;"` : '';
				return `
					<article class="kpi-card-dashboard${kpi.link ? ' kpi-card-link' : ''}" ${linkProps}>
						<div class="kpi-head">
							<div>
								<p class="kpi-label">${kpi.label}</p>
								<p class="kpi-value">${kpi.value}</p>
								${kpi.subtitle ? `<p class="kpi-subtitle">${kpi.subtitle}</p>` : ''}
							</div>
							<div class="kpi-icon-square ${kpi.color}">${kpi.icon}</div>
						</div>
						<p class="kpi-meta">${kpi.meta}</p>
						${kpi.subMeta ? `<p class="kpi-meta split-meta">${kpi.subMeta}</p>` : ''}
					</article>
				`;
			}).join('');
			kpiGrid.querySelectorAll('[data-kpi-link]').forEach((el) => {
				el.addEventListener('click', () => { window.location.href = el.getAttribute('data-kpi-link'); });
				el.addEventListener('keydown', (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						window.location.href = el.getAttribute('data-kpi-link');
					}
				});
			});
		}

		const alertFeed = document.getElementById('dash-alert-feed');
		if (alertFeed) {
			const criticalItems = stockAlerts.filter((a) => a.current < a.min * 0.5);
			const lowItems = stockAlerts.filter((a) => a.current >= a.min * 0.5 && a.current < a.min);
			const healthyItems = stockAlerts.filter((a) => a.current >= a.min);

			// Determine overall severity colour
			const bannerClass = criticalItems.length > 0 ? 'alert-banner-critical'
				: lowItems.length > 0 ? 'alert-banner-warning'
				: 'alert-banner-ok';
			const bannerIcon = criticalItems.length > 0 ? 'fa-circle-exclamation'
				: lowItems.length > 0 ? 'fa-triangle-exclamation'
				: 'fa-circle-check';
			const bannerText = criticalItems.length > 0
				? `${criticalItems.length} critical · ${lowItems.length} low · ${healthyItems.length} healthy`
				: lowItems.length > 0
				? `${lowItems.length} low stock · ${healthyItems.length} healthy`
				: `All ${healthyItems.length} materials at healthy levels`;

			const rows = stockAlerts.map((a) => {
				const isCritical = a.current < a.min * 0.5;
				const isLow = !isCritical && a.current < a.min;
				const rowClass = isCritical ? 'alert-row-critical' : isLow ? 'alert-row-warning' : 'alert-row-ok';
				const rowIcon = isCritical ? 'fa-circle-exclamation' : isLow ? 'fa-triangle-exclamation' : 'fa-circle-check';
				const level = isCritical ? 'Critical' : isLow ? 'Low' : 'Healthy';
				const pct = a.min > 0 ? Math.round((a.current / a.min) * 100) : 100;
				const barClass = isCritical ? 'alert-bar-critical' : isLow ? 'alert-bar-warning' : 'alert-bar-ok';
				return `
					<li class="alert-row ${rowClass}">
						<i class="fa-solid ${rowIcon} alert-row-icon"></i>
						<div class="alert-row-body">
							<div class="alert-row-top">
								<strong>${a.item}</strong>
								<span class="alert-level-badge alert-badge-${isCritical ? 'critical' : isLow ? 'warning' : 'ok'}">${level}</span>
							</div>
							<div class="alert-row-sub">${a.current} / ${a.min} units</div>
							<div class="alert-progress-track"><div class="alert-progress-bar ${barClass}" style="width:${Math.min(pct, 100)}%"></div></div>
						</div>
					</li>
				`;
			}).join('');

			const isOpen = alertFeed.dataset.open !== 'false'; // default open
			alertFeed.innerHTML = `
				<div class="alert-summary ${bannerClass}" id="dash-alert-summary" role="button" tabindex="0" aria-expanded="${isOpen}">
					<span class="alert-summary-left"><i class="fa-solid ${bannerIcon}"></i> ${bannerText}</span>
					<i class="fa-solid fa-chevron-down alert-chevron${isOpen ? ' open' : ''}"></i>
				</div>
				<ul class="alert-list${isOpen ? ' open' : ''}" id="dash-alert-list">${rows}</ul>
			`;

			const summary = document.getElementById('dash-alert-summary');
			const list = document.getElementById('dash-alert-list');
			const toggle = () => {
				const nowOpen = list.classList.toggle('open');
				alertFeed.dataset.open = String(nowOpen);
				summary.setAttribute('aria-expanded', String(nowOpen));
				summary.querySelector('.alert-chevron').classList.toggle('open', nowOpen);
			};
			summary.addEventListener('click', toggle);
			summary.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); });
		}

		const stamp = document.getElementById('dash-timestamp');
		if (stamp) {
			const lastUpdate = getLastDataUpdateStamp();
			stamp.textContent = lastUpdate ? new Date(lastUpdate).toLocaleString() : '--';
		}
	};

	renderDashboardYearSelector();
	renderDashboardLiveSummary();

	const revData = buildRevenueData();
	renderDashboardCharts(revData, buildDailySales());
	renderProfitLossChart(revData);

	const equipmentPanel = document.getElementById('dash-equipment-panel');
	const equipmentContent = document.getElementById('dash-equipment-content');
	const renderDashboardEquipmentStatus = () => {
		equipmentStatus = loadEquipmentFromStorage();
		dashTrace('equipment:render:start', { count: Array.isArray(equipmentStatus) ? equipmentStatus.length : -1 });
		if (!equipmentContent) {
			return;
		}
		const faultyList = equipmentStatus.filter((eq) => ['faulty', 'faulty_needs_repair'].includes(eq.status));
		const repairList = equipmentStatus.filter((eq) => eq.status === 'needs_repair');
		const allOperational = faultyList.length === 0 && repairList.length === 0;
		const criticalFault = faultyList.length > 2;

		if (equipmentPanel) {
			equipmentPanel.classList.remove('eq-panel-all-ok', 'eq-panel-critical');
			if (allOperational) equipmentPanel.classList.add('eq-panel-all-ok');
			else if (criticalFault) equipmentPanel.classList.add('eq-panel-critical');
		}

		const rowsMarkup = equipmentStatus.map((eq, idx) => {
			const issues = getEquipmentIssues(eq.status);
			const tone = getEquipmentWarningTone(eq.status);
			const statusOptions = [
				{ value: 'operational', label: 'Operational' },
				{ value: 'needs_repair', label: 'Needs Repair' },
				{ value: 'faulty', label: 'Faulty' },
				{ value: 'faulty_needs_repair', label: 'Faulty + Repair' },
			].map((o) => `<option value="${o.value}"${eq.status === o.value ? ' selected' : ''}>${o.label}</option>`).join('');
			const selectClass = eq.status === 'operational' ? 'eq-sel-ok' : eq.status === 'needs_repair' ? 'eq-sel-warning' : 'eq-sel-danger';
			return `
				<tr class="${isEquipmentWarningStatus(eq.status) ? `equipment-warning-row equipment-warning-row-${tone}` : ''}">
					<td>${eq.code}</td>
					<td>${renderEquipmentLabel(eq)}</td>
					<td>
						<select class="eq-status-select ${selectClass}" data-dash-eq-idx="${idx}">${statusOptions}</select>
					</td>
					<td><span class="badge ${issues === '-' ? 'badge-green' : issues === 'R' ? 'badge-yellow' : 'badge-red'}">${issues}</span></td>
					<td>${formatDateDisplay(eq.lastMaintenance)}</td>
					<td>${formatDateDisplay(eq.nextMaintenance)}</td>
				</tr>
			`;
		}).join('');

		// Build coloured per-type chips for the footer
		const operationalCount = equipmentStatus.filter((eq) => eq.status === 'operational').length;
		const faultyOnlyCount = equipmentStatus.filter((eq) => eq.status === 'faulty').length;
		const faultyRepairCount = equipmentStatus.filter((eq) => eq.status === 'faulty_needs_repair').length;
		const repairOnlyCount = equipmentStatus.filter((eq) => eq.status === 'needs_repair').length;

		const chips = [];
		if (faultyOnlyCount)   chips.push(`<span class="eq-footer-chip eq-chip-danger"><i class="fa-solid fa-circle-xmark"></i> ${faultyOnlyCount} Faulty</span>`);
		if (faultyRepairCount) chips.push(`<span class="eq-footer-chip eq-chip-danger"><i class="fa-solid fa-circle-xmark"></i> ${faultyRepairCount} Faulty + Repair</span>`);
		if (repairOnlyCount)   chips.push(`<span class="eq-footer-chip eq-chip-warning"><i class="fa-solid fa-triangle-exclamation"></i> ${repairOnlyCount} Needs Repair</span>`);
		if (operationalCount)  chips.push(`<span class="eq-footer-chip eq-chip-ok"><i class="fa-solid fa-circle-check"></i> ${operationalCount} Operational</span>`);

		const footerClass = faultyList.length > 0 ? 'eq-footer-danger' : repairList.length > 0 ? 'eq-footer-warning' : 'eq-footer-ok';

		equipmentContent.innerHTML = `
			<div class="eq-table-wrapper">
				<table class="data-table">
					<thead>
						<tr>
							<th>Code</th>
							<th>Equipment</th>
							<th>Status</th>
							<th>Issues</th>
							<th>Last Maintenance</th>
							<th>Next Maintenance</th>
						</tr>
					</thead>
					<tbody id="dash-equipment-tbody">${rowsMarkup}</tbody>
				</table>
			</div>
			<div class="eq-status-footer ${footerClass}">
				<span class="eq-footer-label"><i class="fa-solid fa-chart-simple"></i> ${equipmentStatus.length} machine${equipmentStatus.length !== 1 ? 's' : ''} total</span>
				<div class="eq-footer-chips">${chips.join('')}</div>
			</div>
		`;

		// Allow editing status directly from dashboard — changes sync back to inventory
		const dashTbody = document.getElementById('dash-equipment-tbody');
		if (dashTbody) {
			dashTbody.onchange = async (e) => {
				const sel = e.target.closest('select[data-dash-eq-idx]');
				if (!sel) return;
				const idx = Number(sel.dataset.dashEqIdx);
				if (!equipmentStatus[idx]) return;
				dashTrace('equipment:edit:change', { idx, nextStatus: sel.value, id: equipmentStatus[idx] && equipmentStatus[idx].id ? String(equipmentStatus[idx].id) : '' });
				equipmentStatus[idx].status = sel.value;
				const saved = await saveOneEquipmentToServer(equipmentStatus[idx]);
				dashTrace('equipment:edit:save-result', { idx, success: !!saved });
				saveEquipmentToStorage(equipmentStatus);
				renderDashboardEquipmentStatus();
			};
		}
		dashTrace('equipment:render:done', {
			count: equipmentStatus.length,
			faulty: equipmentStatus.filter((eq) => ['faulty', 'faulty_needs_repair'].includes(eq.status)).length,
			needsRepair: equipmentStatus.filter((eq) => eq.status === 'needs_repair').length,
		});
	};
	renderDashboardEquipmentStatus();

	const refreshDashboardView = () => {
		dashTrace('refresh:start', { reason: 'dashboard-refresh' });
		renderDashboardYearSelector();
		const rd = buildRevenueData();
		renderDashboardLiveSummary();
		renderDashboardEquipmentStatus();
		renderDashboardCharts(rd, buildDailySales());
		renderProfitLossChart(rd);
		dashTrace('refresh:done', { equipmentCount: Array.isArray(equipmentStatus) ? equipmentStatus.length : -1 });
	};

	if (!window.__wwDashboardStorageBound) {
		window.__wwDashboardStorageBound = true;

		// Cross-tab: localStorage storage event
		window.addEventListener('storage', (event) => {
			dashTrace('sync:storage-event', { key: event && event.key ? String(event.key) : '' });
			const dashKeys = ['ww_raw_materials', 'ww_daily_production', 'ww_equipment', 'ww_production_batches', 'ww_accounting_data_v2', 'ww_purchase_data_v2', 'ww_market_yearly_values'];
			if (dashKeys.includes(event.key) || (event.key && event.key.startsWith('ww_sales_'))) {
				refreshDashboardView();
			}
		});

		// Instant cross-tab via BroadcastChannel for sales updates
		try {
			const salesDashChannel = new BroadcastChannel('ww_sales_sync');
			salesDashChannel.onmessage = () => {
				refreshDashboardView();
			};
		} catch (_e) { /* ignore */ }

		// Instant cross-tab via BroadcastChannel (fires the moment inventory saves)
		try {
			const eqChannel = new BroadcastChannel('ww_equipment_sync');
			eqChannel.onmessage = (e) => {
				dashTrace('sync:channel', { channel: 'ww_equipment_sync', type: e && e.data && e.data.type ? String(e.data.type) : '' });
				if (e.data && e.data.type === 'equipment_updated') {
					renderDashboardEquipmentStatus();
				}
			};
			window.__wwEqChannel = eqChannel;
		} catch (_e) { /* fallback to storage event */ }

		try {
			const rawChannel = new BroadcastChannel('ww_raw_materials_sync');
			rawChannel.onmessage = (e) => {
				if (e.data && e.data.type === 'raw_materials_updated') {
					refreshDashboardView();
				}
			};
			window.__wwRawChannel = rawChannel;
		} catch (_e) { /* fallback to storage event */ }

		// Instant cross-tab: accounting changes
		try {
			const acctChannel = new BroadcastChannel('ww_accounting_sync');
			acctChannel.onmessage = () => {
				refreshDashboardView();
			};
		} catch (_e) { /* fallback to storage event */ }

		// Instant cross-tab: purchase changes
		try {
			const purchChannel = new BroadcastChannel('ww_purchase_sync');
			purchChannel.onmessage = () => {
				refreshDashboardView();
			};
		} catch (_e) { /* fallback to storage event */ }

		const refreshOnFocus = () => {
			if (document.body.getAttribute('data-page') === 'dashboard') {
				refreshDashboardView();
			}
		};
		window.addEventListener('focus', refreshOnFocus);
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) refreshOnFocus();
		});
	}
	document.addEventListener('ww-refresh-page', refreshDashboardView);
}

async function initInventoryPage() {
	if (document.body.getAttribute('data-page') !== 'inventory') {
		return;
	}

	const userRole = await resolveCurrentUserRole();
	const canAdd = ['ceo', 'manager', 'supervisor'].includes(userRole);

	const invTraceEnabled = (() => {
		try {
			const q = new URLSearchParams(window.location.search);
			if (q.get('traceInv') === '1') localStorage.setItem('ww_trace_inventory', '1');
			if (q.get('traceInv') === '0') localStorage.removeItem('ww_trace_inventory');
			return localStorage.getItem('ww_trace_inventory') === '1';
		} catch (_e) {
			return false;
		}
	})();

	const invTrace = (event, details) => {
		if (!invTraceEnabled) return;
		const payload = details && typeof details === 'object' ? details : {};
		try {
			console.log('[INV-TRACE]', new Date().toISOString(), event, payload);
		} catch (_e) { /* no-op */ }
	};

	invTrace('init:start', { path: window.location.pathname, search: window.location.search });

	const INVENTORY_MONTHS_KEY = 'ww_inventory_months';
	const INVENTORY_MONTHLY_MIGRATED_KEY = 'ww_inventory_monthly_migrated_v1';
	const INVENTORY_FINISHED_REBUCKET_KEY = 'ww_inventory_finished_rebucket_v1';
	const inventoryMonthStorageKey = (month) => `ww_inventory_${month}`;
	const loadSyncedFinishedProducts = () => {
		try {
			const rows = JSON.parse(localStorage.getItem('ww_finished_products') || '[]');
			return Array.isArray(rows) ? rows : [];
		} catch (_e) {
			return [];
		}
	};
	const getInventoryMonths = () => {
		let fromIndex = [];
		try { fromIndex = JSON.parse(localStorage.getItem(INVENTORY_MONTHS_KEY) || '[]'); } catch (_e) { fromIndex = []; }
		const recovered = new Set(Array.isArray(fromIndex) ? fromIndex : []);
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i);
			if (!key) continue;
			const match = /^ww_inventory_(\d{4}-\d{2})$/.exec(key);
			if (match && match[1]) recovered.add(match[1]);
		}
		const inferMonthFromRaw = (row) => {
			const raw = String((row && (row.date || row.addedDate || row.month)) || '').trim();
			const iso = raw.match(/^(\d{4}-\d{2})/);
			if (iso) return iso[1];
			const dmy = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
			if (dmy) {
				const m = Number(dmy[2]);
				let y = Number(dmy[3]);
				if (y < 100) y += 2000;
				if (m >= 1 && m <= 12 && y >= 2000) return `${y}-${String(m).padStart(2, '0')}`;
			}
			const d = raw ? new Date(raw) : null;
			if (d && !isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
			return '';
		};
		for (const product of loadSyncedFinishedProducts()) {
			const month = inferMonthFromRaw(product);
			if (/^\d{4}-\d{2}$/.test(month)) recovered.add(month);
		}
		return Array.from(recovered).sort();
	};
	const saveInventoryMonths = (months) => {
		localStorage.setItem(INVENTORY_MONTHS_KEY, JSON.stringify(months));
	};
	const ensureInventoryMonthExists = (month) => {
		const months = getInventoryMonths();
		if (!months.includes(month)) {
			months.push(month);
			months.sort();
			saveInventoryMonths(months);
		}
	};
	const hasAnyInventoryMonthPayload = () => {
		const months = getInventoryMonths();
		return months.some((m) => {
			try {
				const loaded = JSON.parse(localStorage.getItem(inventoryMonthStorageKey(m)) || 'null');
				return loaded && typeof loaded === 'object';
			} catch (_e) {
				return false;
			}
		});
	};
	const now = new Date();
	const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	const initialMonths = getInventoryMonths();
	if (!initialMonths.length) saveInventoryMonths([thisMonth]);
	let currentInventoryMonth = initialMonths.includes(thisMonth)
		? thisMonth
		: (initialMonths[initialMonths.length - 1] || thisMonth);
	ensureInventoryMonthExists(currentInventoryMonth);

	let rawMaterials = [];
	let finishedProducts = [];
	let equipment = [];
	let customers = [];

	const inferProductMonth = (row) => {
		const raw = String((row && (row.date || row.addedDate)) || '').trim();
		if (/^\d{4}-\d{2}/.test(raw)) return raw.slice(0, 7);
		const dmy = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
		if (dmy) {
			const day = Number(dmy[1]);
			const month = Number(dmy[2]);
			let year = Number(dmy[3]);
			if (year < 100) year += 2000;
			if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000) {
				return `${year}-${String(month).padStart(2, '0')}`;
			}
		}
		if (raw) {
			const d = new Date(raw);
			if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
		}
		return thisMonth;
	};

	const collectAllFinishedProductsAcrossMonths = () => {
		const byMonth = {};
		for (const product of loadSyncedFinishedProducts()) {
			if (!product || typeof product !== 'object') continue;
			const month = inferProductMonth(product);
			if (!byMonth[month]) byMonth[month] = [];
			byMonth[month].push({ ...product, month });
		}
		for (const month of getInventoryMonths()) {
			let loaded = null;
			try {
				loaded = JSON.parse(localStorage.getItem(inventoryMonthStorageKey(month)) || 'null');
			} catch (_e) {
				loaded = null;
			}
			if (loaded && typeof loaded === 'object' && Array.isArray(loaded.finishedProducts)) {
				byMonth[month] = loaded.finishedProducts
					.filter((product) => product && typeof product === 'object')
					.map((product) => ({ ...product, month: inferProductMonth(product) || month }));
			}
		}
		const rows = [];
		for (const month of Object.keys(byMonth).sort()) {
			rows.push(...byMonth[month]);
		}
		return rows;
	};

	const migrateLegacyInventoryMonthlyIfNeeded = () => {
		if (localStorage.getItem(INVENTORY_MONTHLY_MIGRATED_KEY) === '1') return;
		if (hasAnyInventoryMonthPayload()) {
			const legacyFinished = loadFinishedProductsFromStorage();
			const months = new Set(getInventoryMonths());
			for (const product of legacyFinished) {
				months.add(inferProductMonth(product));
			}
			saveInventoryMonths(Array.from(months).sort());
			localStorage.setItem(INVENTORY_MONTHLY_MIGRATED_KEY, '1');
			return;
		}

		const legacyRaw = loadRawMaterialsFromStorage();
		const legacyFinished = loadFinishedProductsFromStorage();
		const legacyEquipment = loadEquipmentFromStorage();
		const existingMonths = new Set(getInventoryMonths());
		const finishedByMonth = {};

		for (const product of legacyFinished) {
			const month = inferProductMonth(product);
			existingMonths.add(month);
			if (!finishedByMonth[month]) finishedByMonth[month] = [];
			finishedByMonth[month].push({ ...product });
		}

		if (!existingMonths.size) existingMonths.add(thisMonth);
		const months = Array.from(existingMonths).sort();
		saveInventoryMonths(months);

		for (const month of months) {
			const payload = {
				rawMaterials: month === thisMonth ? legacyRaw : [],
				finishedProducts: finishedByMonth[month] || [],
				equipment: month === thisMonth ? legacyEquipment : [],
				customers: [],
			};
			const monthKey = inventoryMonthStorageKey(month);
			localStorage.setItem(monthKey, JSON.stringify(payload));
			syncToServer(monthKey, payload);
		}

		localStorage.setItem(INVENTORY_MONTHLY_MIGRATED_KEY, '1');
	};

	const rebucketFinishedProductsByDateIfNeeded = () => {
		if (localStorage.getItem(INVENTORY_FINISHED_REBUCKET_KEY) === '1') return;

		let legacyAll = [];
		try {
			legacyAll = JSON.parse(localStorage.getItem('ww_finished_products') || '[]');
		} catch (_e) {
			legacyAll = [];
		}
		if (!Array.isArray(legacyAll) || !legacyAll.length) {
			localStorage.setItem(INVENTORY_FINISHED_REBUCKET_KEY, '1');
			return;
		}

		const byMonth = {};
		const months = new Set(getInventoryMonths());
		for (const product of legacyAll) {
			const month = inferProductMonth(product);
			months.add(month);
			if (!byMonth[month]) byMonth[month] = [];
			byMonth[month].push({ ...product, month });
		}

		const monthList = Array.from(months).sort();
		if (!monthList.length) {
			localStorage.setItem(INVENTORY_FINISHED_REBUCKET_KEY, '1');
			return;
		}

		saveInventoryMonths(monthList);
		for (const month of monthList) {
			let payload = null;
			try {
				payload = JSON.parse(localStorage.getItem(inventoryMonthStorageKey(month)) || 'null');
			} catch (_e) {
				payload = null;
			}
			const nextPayload = {
				rawMaterials: Array.isArray(payload?.rawMaterials) ? payload.rawMaterials : [],
				finishedProducts: byMonth[month] || [],
				equipment: Array.isArray(payload?.equipment) ? payload.equipment : [],
				customers: Array.isArray(payload?.customers) ? payload.customers : [],
			};
			const monthKey = inventoryMonthStorageKey(month);
			localStorage.setItem(monthKey, JSON.stringify(nextPayload));
			syncToServer(monthKey, nextPayload);
		}

		localStorage.setItem(INVENTORY_FINISHED_REBUCKET_KEY, '1');

		if (!monthList.includes(currentInventoryMonth)) {
			currentInventoryMonth = monthList[monthList.length - 1] || thisMonth;
		}
	};

	const persistInventoryMonthState = () => {
		invTrace('persist:start', {
			month: currentInventoryMonth,
			rawMaterials: Array.isArray(rawMaterials) ? rawMaterials.length : -1,
			finishedProducts: Array.isArray(finishedProducts) ? finishedProducts.length : -1,
			equipment: Array.isArray(equipment) ? equipment.length : -1,
			customers: Array.isArray(customers) ? customers.length : -1,
		});
		const payload = {
			rawMaterials: Array.isArray(rawMaterials) ? rawMaterials : [],
			finishedProducts: Array.isArray(finishedProducts) ? finishedProducts : [],
			equipment: Array.isArray(equipment) ? equipment : [],
			customers: Array.isArray(customers) ? customers : [],
		};
		const monthKey = inventoryMonthStorageKey(currentInventoryMonth);
		localStorage.setItem(monthKey, JSON.stringify(payload));
		syncToServer(monthKey, payload);

		// Keep legacy snapshot keys in sync for other modules.
		localStorage.setItem('ww_raw_materials', JSON.stringify(payload.rawMaterials));
		syncToServer('ww_raw_materials', payload.rawMaterials);
		const allFinishedProducts = collectAllFinishedProductsAcrossMonths();
		localStorage.setItem('ww_finished_products', JSON.stringify(allFinishedProducts));
		syncToServer('ww_finished_products', allFinishedProducts);
		rebuildDailyProductionLog(allFinishedProducts);
		// Keep global equipment cache from the live equipment array (server-backed).
		// Do not rely on stale monthly snapshots for this shared dataset.
		localStorage.setItem('ww_equipment', JSON.stringify(Array.isArray(equipment) ? equipment : []));

		try {
			const rawChannel = new BroadcastChannel('ww_raw_materials_sync');
			rawChannel.postMessage({ type: 'raw_materials_updated', month: currentInventoryMonth });
			rawChannel.close();
		} catch (_e) { /* noop */ }
		try {
			const finishedChannel = new BroadcastChannel('ww_finished_products_sync');
			finishedChannel.postMessage({ type: 'finished_products_updated', month: currentInventoryMonth });
			finishedChannel.close();
		} catch (_e) { /* noop */ }
		try {
			const equipmentChannel = new BroadcastChannel('ww_equipment_sync');
			equipmentChannel.postMessage({ type: 'equipment_updated', month: currentInventoryMonth });
			equipmentChannel.close();
		} catch (_e) { /* noop */ }
		invTrace('persist:done', { month: currentInventoryMonth, monthKey, finishedProducts: payload.finishedProducts.length, equipment: payload.equipment.length });
	};

	const loadInventoryMonthState = async (month) => {
		invTrace('month:load:start', { month });
		currentInventoryMonth = month;
		const syncedForMonth = loadSyncedFinishedProducts().filter((product) => inferProductMonth(product) === currentInventoryMonth);
		const monthKey = inventoryMonthStorageKey(month);
		let loaded = await loadFromServerForceFresh(monthKey);
		if (!loaded || typeof loaded !== 'object') {
			try {
				loaded = JSON.parse(localStorage.getItem(monthKey) || 'null');
			} catch (_e) {
				loaded = null;
			}
		}

		if (loaded && typeof loaded === 'object') {
			rawMaterials = Array.isArray(loaded.rawMaterials) ? loaded.rawMaterials : [];
			if (Array.isArray(loaded.finishedProducts) && loaded.finishedProducts.length > 0) {
				finishedProducts = loaded.finishedProducts;
			} else {
				finishedProducts = syncedForMonth;
			}
			equipment = Array.isArray(loaded.equipment) ? loaded.equipment : [];
			// Equipment is global data (same physical machines regardless of month),
			// so ALWAYS fetch fresh from the server — never trust the monthly snapshot
			// for it. Stale cache here was the main cause of edits going away on
			// refresh and the dashboard / inventory page showing different data.
			equipment = await fetchEquipmentFromServer();
			customers = Array.isArray(loaded.customers) ? loaded.customers : [];
			invTrace('month:load:from-storage', { month, rawMaterials: rawMaterials.length, finishedProducts: finishedProducts.length, equipment: equipment.length, customers: customers.length });
		} else {
			if (hasAnyInventoryMonthPayload()) {
				rawMaterials = [];
				finishedProducts = syncedForMonth;
				equipment = await fetchEquipmentFromServer();
				customers = [];
				persistInventoryMonthState();
				invTrace('month:load:new-empty-month', { month, finishedProducts: finishedProducts.length, equipment: equipment.length });
			} else {
				rawMaterials = loadRawMaterialsFromStorage();
				finishedProducts = loadFinishedProductsFromStorage();
				equipment = await fetchEquipmentFromServer();
				customers = [];
				persistInventoryMonthState();
				invTrace('month:load:legacy-bootstrap', { month, finishedProducts: finishedProducts.length, equipment: equipment.length });
			}
		}
		invTrace('month:load:done', { month, rawMaterials: rawMaterials.length, finishedProducts: finishedProducts.length, equipment: equipment.length, customers: customers.length });
	};

	const monthSelect = document.getElementById('inv-month-select');
	const yearSelect = document.getElementById('inv-year-select');
	const yearLabel = document.getElementById('inv-year-label');
	const newMonthBtn = document.getElementById('inv-new-month-btn');
	let selectedInventoryYear = null;
	const renderInventoryMonthOptions = (options) => {
		const opts = options || {};
		if (!monthSelect) return;
		const allMonths = getInventoryMonths();
		const years = [...new Set(allMonths.map((m) => Number(String(m).slice(0, 4))).filter(Number.isFinite))].sort((a, b) => a - b);
		const hasMultiYear = years.length > 1;
		if (yearSelect && yearLabel) {
			yearSelect.style.display = hasMultiYear ? '' : 'none';
			yearLabel.style.display = hasMultiYear ? '' : 'none';
			if (hasMultiYear) {
				if (!selectedInventoryYear || !years.includes(selectedInventoryYear)) {
					selectedInventoryYear = Number(String(currentInventoryMonth || allMonths[allMonths.length - 1] || '').slice(0, 4)) || years[years.length - 1];
				}
				yearSelect.innerHTML = [...years].sort((a, b) => b - a).map((y) => `<option value="${y}">${y}</option>`).join('');
				yearSelect.value = String(selectedInventoryYear);
			} else {
				selectedInventoryYear = years[0] || null;
			}
		}
		const months = hasMultiYear
			? allMonths.filter((m) => Number(String(m).slice(0, 4)) === selectedInventoryYear)
			: allMonths;
		monthSelect.innerHTML = months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
		if (!months.includes(currentInventoryMonth) && months.length) currentInventoryMonth = months[months.length - 1];
		if (opts.preserveCurrent && currentInventoryMonth) monthSelect.value = currentInventoryMonth;
		else if (months.length) monthSelect.value = months.includes(currentInventoryMonth) ? currentInventoryMonth : months[months.length - 1];
	};

	migrateLegacyInventoryMonthlyIfNeeded();
	rebucketFinishedProductsByDateIfNeeded();
	await loadInventoryMonthState(currentInventoryMonth);
	renderInventoryMonthOptions();

	const nextNumericId = (rows) => rows.reduce((maxId, row) => Math.max(maxId, Number(row.id || 0)), 0) + 1;

	const bindStatsCardLink = (cardId, tabName, panelId) => {
		const card = document.getElementById(cardId);
		if (!card || card.dataset.bound === '1') {
			return;
		}
		const openTargetTab = () => {
			switchTab('inv', tabName);
			const tablePanel = document.getElementById(panelId);
			if (tablePanel) {
				tablePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		};

		card.addEventListener('click', openTargetTab);
		card.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				openTargetTab();
			}
		});
		card.dataset.bound = '1';
	};

	const renderStats = () => {
		const lowCount = rawMaterials.filter((m) => m.quantity < m.minLevel).length;
		const criticalCount = rawMaterials.filter((m) => m.quantity < m.minLevel * 0.5).length;
		const rawMaterialUnits = rawMaterials.reduce((sum, m) => sum + Number(m.quantity || 0), 0);
		const finishedQty = finishedProducts.reduce((sum, p) => sum + Number(p.qty || 0), 0);
		const allFinishedRows = collectAllFinishedProductsAcrossMonths();
		const allMonthsTotal = allFinishedRows.reduce((sum, p) => sum + (Number(p.qty) || 0), 0);
		const selectedYear = Number(String(currentInventoryMonth || '').slice(0, 4));
		const yearMonths = getInventoryMonths().filter((m) => Number(String(m).slice(0, 4)) === selectedYear);
		const isYearComplete = yearMonths.length === 12;
		const yearTotal = allFinishedRows
			.filter((p) => Number(String(p.month || inferProductMonth(p) || '').slice(0, 4)) === selectedYear)
			.reduce((sum, p) => sum + (Number(p.qty) || 0), 0);
		const aggregateLabel = isYearComplete ? `Total for ${selectedYear}` : 'All months';
		const aggregateTotal = isYearComplete ? yearTotal : allMonthsTotal;
		const statsContainer = document.getElementById('inv-stats-row');
		if (statsContainer) {
			statsContainer.innerHTML = `
				<div class="stat-card stat-card-link" id="inv-raw-materials-card" role="button" tabindex="0" aria-label="Open raw materials table"><div class="s-icon"><i class="fa-solid fa-layer-group"></i></div><p class="s-label">Raw Materials</p><p class="s-value" id="inv-raw-materials-value">${rawMaterials.length}</p><p class="s-meta" id="inv-raw-materials-meta">${formatNumber(rawMaterialUnits)} total units in stock.</p></div>
				<div class="stat-card stat-card-link" id="inv-finished-products-card" role="button" tabindex="0" aria-label="Open finished products table"><div class="s-icon"><i class="fa-solid fa-box-open"></i></div><p class="s-label">Finished Products</p><p class="s-value">${formatNumber(finishedQty)}</p><p class="s-meta inv-total-caption">Total for ${monthLabel(currentInventoryMonth)}</p><div class="inv-overall-block"><p class="inv-overall-value">${formatNumber(aggregateTotal)}</p><p class="s-meta inv-total-caption">${aggregateLabel}</p></div></div>
				<a class="stat-card stat-card-link" id="inv-low-stock-card" href="dashboard.html#dash-stock-alerts-panel" aria-label="Open stock alerts on dashboard" style="text-decoration:none;color:inherit;display:block;"><div class="s-icon"><i class="fa-solid fa-triangle-exclamation"></i></div><p class="s-label">Low Stock</p><p class="s-value">${lowCount}</p><p class="s-meta">${criticalCount} critically low \u2014 needs reorder</p></a>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-users"></i></div><p class="s-label">Active Customers</p><p class="s-value">${customers.filter((c) => c.status === 'active').length}</p><p class="s-meta">Distribution partners</p></div>
			`;
		}
		bindStatsCardLink('inv-raw-materials-card', 'materials', 'inv-tab-materials');
		bindStatsCardLink('inv-finished-products-card', 'products', 'inv-tab-products');

		document.querySelectorAll('.table-add-btn').forEach((button) => {
			button.disabled = !canAdd;
			button.title = canAdd ? 'Add a new row' : 'You do not have permission to add rows';
		});
	};

	/* ── Inventory draft helpers — must be declared before the render functions below ── */
	const invDraftKey = (entity) => `ww_inv_modal_draft_${entity}`;
	const getInvDraft = (entity) => { try { return JSON.parse(localStorage.getItem(invDraftKey(entity))); } catch (_e) { return null; } };

	const renderMaterials = () => {
		const materialsBody = document.getElementById('inv-materials-tbody');
		if (!materialsBody) {
			return;
		}
		const matDraft = getInvDraft('material');
		const draftRow = matDraft ? `<tr class="draft-row"><td>${escapeHtml(matDraft.material || 'Unsaved material')}</td><td>${escapeHtml(matDraft.quantity || '')}</td><td>${escapeHtml(matDraft.minLevel || '')}</td><td>${escapeHtml(matDraft.supplier || '')}</td><td>${escapeHtml(matDraft.restocked || '')}</td><td><span class="badge badge-orange">Draft</span></td><td><div class="row-actions"><button class="btn-edit inv-resume-draft-btn" data-draft-entity="material" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete inv-clear-draft-btn" data-draft-entity="material" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td></tr>` : '';
		materialsBody.innerHTML = draftRow + rawMaterials.map((m, idx) => {
			const isCritical = m.quantity < m.minLevel * 0.5;
			const isLow = m.quantity < m.minLevel;
			const statusLabel = isCritical ? 'Critical - Auto Reorder' : (isLow ? 'Low Stock' : 'Adequate');
			const statusIcon = isCritical
				? '<i class="fa-solid fa-triangle-exclamation"></i>'
				: isLow
					? '<i class="fa-solid fa-triangle-exclamation"></i>'
					: '<i class="fa-solid fa-circle-check"></i>';
			return `
				<tr>
					<td>${m.material}</td>
					<td><input type="number" min="0" step="1" class="inv-num-input" data-mat-idx="${idx}" data-field="quantity" value="${Number(m.quantity || 0)}"></td>
					<td><input type="number" min="0" step="1" class="inv-num-input" data-mat-idx="${idx}" data-field="minLevel" value="${Number(m.minLevel || 0)}"></td>
					<td>${m.supplier}</td>
					<td>${m.restocked}</td>
					<td><span class="status-pill ${isCritical ? 'status-red' : isLow ? 'status-yellow' : 'status-green'}">${statusIcon} ${statusLabel}</span></td>
					<td><div class="row-actions"><button class="btn-edit inv-edit-btn" data-edit-entity="material" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete inv-delete-btn" data-delete-entity="material" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			`;
		}).join('');

		materialsBody.onchange = (e) => {
			const input = e.target.closest('input[data-mat-idx][data-field]');
			if (!input) return;
			const idx = Number(input.dataset.matIdx);
			const field = input.dataset.field;
			if (!rawMaterials[idx] || !field) return;
			const nextVal = Math.max(0, Number(input.value || 0));
			rawMaterials[idx][field] = Number.isFinite(nextVal) ? nextVal : 0;
			persistInventoryMonthState();
			rerenderInventory();
		};

		const rawMaterialsValue = document.getElementById('inv-raw-materials-value');
		if (rawMaterialsValue) {
			rawMaterialsValue.textContent = String(materialsBody.querySelectorAll('tr').length);
		}
	};

	const renderProducts = () => {
		const productsBody = document.getElementById('inv-products-tbody');
		if (!productsBody) {
			return;
		}
		const prodDraft = getInvDraft('product');
		const draftRow = prodDraft ? `<tr class="draft-row"><td>${escapeHtml(prodDraft.product || 'Unsaved product')}</td><td>${escapeHtml(prodDraft.qty || '')}</td><td>${escapeHtml(prodDraft.location || '')}</td><td>${escapeHtml(prodDraft.date || '')}</td><td><span class="badge badge-orange">Draft</span></td><td><div class="row-actions"><button class="btn-edit inv-resume-draft-btn" data-draft-entity="product" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete inv-clear-draft-btn" data-draft-entity="product" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td></tr>` : '';
		productsBody.innerHTML = draftRow + finishedProducts.map((p, idx) => {
			const isReady = Number(p.qty || 0) > 0;
			const distributionLabel = isReady
				? '<i class="fa-solid fa-circle-check"></i> Ready for Sale'
				: 'In Production';
			const distributionClass = isReady ? 'status-green' : 'status-grey';
			return `
				<tr>
					<td>${p.product}</td>
					<td>${formatNumber(p.qty)}</td>
					<td>${p.location}</td>
					<td>${formatDateDisplay(p.date || p.addedDate)}</td>
					<td><span class="status-pill ${distributionClass}">${distributionLabel}</span></td>
					<td><div class="row-actions"><button class="btn-edit inv-edit-btn" data-edit-entity="product" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete inv-delete-btn" data-delete-entity="product" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			`;
		}).join('');
	};

	const renderEquipment = () => {
		const equipmentBody = document.getElementById('inv-equipment-tbody');
		if (!equipmentBody) {
			return;
		}
		const eqDraft = getInvDraft('equipment');
		const eqDraftRow = eqDraft ? `<tr class="draft-row"><td>—</td><td>${escapeHtml(eqDraft.equipmentName || 'Unsaved equipment')}</td><td><span class="badge badge-orange">Draft</span></td><td>—</td><td>${escapeHtml(eqDraft.lastMaintenance || '')}</td><td>${escapeHtml(eqDraft.nextMaintenance || '')}</td><td><div class="row-actions"><button class="btn-edit inv-resume-draft-btn" data-draft-entity="equipment" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete inv-clear-draft-btn" data-draft-entity="equipment" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td></tr>` : '';
		equipmentBody.innerHTML = eqDraftRow + equipment.map((eq, idx) => {
			const issues = getEquipmentIssues(eq.status);
			const tone = getEquipmentWarningTone(eq.status);
			const statusOptions = [
				{ value: 'operational', label: 'Operational' },
				{ value: 'needs_repair', label: 'Needs Repair' },
				{ value: 'faulty', label: 'Faulty' },
				{ value: 'faulty_needs_repair', label: 'Faulty + Repair' },
			].map((o) => `<option value="${o.value}"${eq.status === o.value ? ' selected' : ''}>${o.label}</option>`).join('');
			const selectClass = eq.status === 'operational' ? 'eq-sel-ok' : eq.status === 'needs_repair' ? 'eq-sel-warning' : 'eq-sel-danger';
			return `
				<tr class="${isEquipmentWarningStatus(eq.status) ? `equipment-warning-row equipment-warning-row-${tone}` : ''}">
					<td>${eq.code}</td>
					<td>${renderEquipmentLabel(eq)}</td>
					<td>
						<select class="eq-status-select ${selectClass}" data-eq-idx="${idx}">${statusOptions}</select>
					</td>
					<td><span class="badge ${issues === '-' ? 'badge-green' : issues === 'R' ? 'badge-yellow' : 'badge-red'}">${issues}</span></td>
					<td>${formatDateDisplay(eq.lastMaintenance)}</td>
					<td>${formatDateDisplay(eq.nextMaintenance)}</td>
					<td><div class="row-actions"><button class="btn-edit inv-edit-btn" data-edit-entity="equipment" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete inv-delete-btn" data-delete-entity="equipment" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			`;
		}).join('');

		// Delegated change handler — update status, save, re-render
		equipmentBody.onchange = (e) => {
			const sel = e.target.closest('select[data-eq-idx]');
			if (!sel) return;
			const idx = Number(sel.dataset.eqIdx);
			if (!equipment[idx]) return;
			equipment[idx].status = sel.value;
			saveOneEquipmentToServer(equipment[idx]);
			persistInventoryMonthState();
			rerenderInventory();
		};
	};

	const renderCustomers = () => {
		const customersBody = document.getElementById('inv-customers-tbody');
		if (!customersBody) {
			return;
		}
		const custDraft = getInvDraft('customer');
		const custDraftRow = custDraft ? `<tr class="draft-row"><td>${escapeHtml(custDraft.name || 'Unsaved customer')}</td><td>${escapeHtml(custDraft.contact || '')}</td><td>—</td><td>${escapeHtml(custDraft.lastOrder || '')}</td><td><span class="badge badge-orange">Draft</span></td><td><div class="row-actions"><button class="btn-edit inv-resume-draft-btn" data-draft-entity="customer" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete inv-clear-draft-btn" data-draft-entity="customer" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td></tr>` : '';
		customersBody.innerHTML = custDraftRow + customers.map((c, idx) => {
			return `
				<tr>
					<td>${c.name}</td>
					<td>${c.contact}</td>
					<td>${c.orders}</td>
					<td>${c.lastOrder}</td>
					<td><span class="status-dot ${statusDotClass(c.status)}"></span>${c.status === 'active' ? 'Active' : 'Inactive'}</td>
					<td><div class="row-actions"><button class="btn-edit inv-edit-btn" data-edit-entity="customer" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete inv-delete-btn" data-delete-entity="customer" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			`;
		}).join('');
	};

	const renderDeviationAlert = () => {
		const deviationBox = document.getElementById('inv-deviation-box');
		if (!deviationBox) {
			return;
		}

		const faultyList = equipment.filter((eq) => ['faulty', 'faulty_needs_repair'].includes(eq.status));
		const repairList = equipment.filter((eq) => eq.status === 'needs_repair');
		const problemList = [...faultyList, ...repairList];

		deviationBox.classList.remove('danger-box', 'ok-box');
		deviationBox.style.display = 'block';

		if (!equipment.length) {
			deviationBox.style.display = 'none';
			return;
		}

		if (!problemList.length) {
			deviationBox.classList.add('ok-box');
			deviationBox.innerHTML = `
				<div class="deviation-head">
					<i class="fa-solid fa-circle-check"></i>
					<span>Equipment Status Summary</span>
				</div>
				<p>All ${equipment.length} machine${equipment.length > 1 ? 's' : ''} in the table ${equipment.length > 1 ? 'are' : 'is'} fully operational.</p>
			`;
			return;
		}

		deviationBox.classList.add('danger-box');
		deviationBox.innerHTML = `
			<div class="deviation-head danger-head">
				<i class="fa-solid fa-triangle-exclamation"></i>
				<span>Equipment Status Summary &mdash; ${problemList.length} machine${problemList.length > 1 ? 's' : ''} need${problemList.length === 1 ? 's' : ''} attention</span>
			</div>
			<div class="deviation-cards">
				${problemList.map((eq) => {
					const tone = getEquipmentWarningTone(eq.status);
					const label = getEquipmentStatusLabel(eq.status, true);
					return `
						<div class="deviation-card deviation-card-${tone}">
							<div class="deviation-card-left">
								<i class="fa-solid fa-triangle-exclamation"></i>
								<div>
									<strong>${eq.code} &mdash; ${eq.equipment}</strong>
									${eq.details ? `<span>${eq.details}</span>` : ''}
								</div>
							</div>
							<span class="deviation-badge deviation-badge-${tone}">${label}</span>
						</div>
					`;
				}).join('')}
			</div>
		`;
	};

	const rerenderInventory = () => {
		invTrace('render:rerender', { month: currentInventoryMonth, rawMaterials: rawMaterials.length, finishedProducts: finishedProducts.length, equipment: equipment.length, customers: customers.length });
		renderStats();
		renderMaterials();
		renderProducts();
		renderEquipment();
		renderCustomers();
		renderDeviationAlert();
	};

	// Do NOT save during init — would overwrite server data with empty localStorage

	rerenderInventory();

	if (monthSelect && !monthSelect.dataset.bound) {
		monthSelect.dataset.bound = '1';
		monthSelect.addEventListener('change', async () => {
			const nextMonth = String(monthSelect.value || '').trim();
			if (!/^\d{4}-\d{2}$/.test(nextMonth)) return;
			selectedInventoryYear = Number(nextMonth.slice(0, 4));
			ensureInventoryMonthExists(nextMonth);
			await loadInventoryMonthState(nextMonth);
			renderInventoryMonthOptions({ preserveCurrent: true });
			rerenderInventory();
		});
	}
	if (yearSelect && !yearSelect.dataset.bound) {
		yearSelect.dataset.bound = '1';
		yearSelect.addEventListener('change', async () => {
			const nextYear = Number(yearSelect.value);
			if (!Number.isFinite(nextYear)) return;
			selectedInventoryYear = nextYear;
			const monthsForYear = getInventoryMonths().filter((m) => Number(String(m).slice(0, 4)) === selectedInventoryYear);
			if (!monthsForYear.length) return;
			await loadInventoryMonthState(monthsForYear[monthsForYear.length - 1]);
			renderInventoryMonthOptions({ preserveCurrent: true });
			rerenderInventory();
		});
	}
	if (newMonthBtn && !newMonthBtn.dataset.bound) {
		newMonthBtn.dataset.bound = '1';
		newMonthBtn.addEventListener('click', async () => {
			const value = window.prompt('Enter month as YYYY-MM', currentInventoryMonth);
			if (!value) return;
			const month = value.trim();
			if (!/^\d{4}-\d{2}$/.test(month)) {
				window.alert('Invalid month format. Use YYYY-MM.');
				return;
			}
			ensureInventoryMonthExists(month);
			selectedInventoryYear = Number(month.slice(0, 4));
			await loadInventoryMonthState(month);
			renderInventoryMonthOptions({ preserveCurrent: true });
			rerenderInventory();
		});
	}

	// Auto-switch to tab from URL ?tab= param (e.g. dashboard Stock Alerts link)
	const tabParam = new URLSearchParams(window.location.search).get('tab');
	if (tabParam && document.getElementById(`inv-tab-${tabParam}`)) {
		switchTab('inv', tabParam);
		document.getElementById(`inv-tab-${tabParam}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	const todayForInput = getTodayDateStr();

	const MODAL_CONFIGS = {
		material: {
			title: 'Add Raw Material',
			fields: [
				{ id: 'material', label: 'Material Name', type: 'text', required: true },
				{ id: 'quantity', label: 'In Stock', type: 'number', min: '0', required: true },
				{ id: 'minLevel', label: 'Minimum Level', type: 'number', min: '0', required: true },
				{ id: 'supplier', label: 'Supplier', type: 'text', placeholder: 'N/A' },
				{ id: 'restocked', label: 'Last Restocked', type: 'date', defaultValue: todayForInput, required: true },
			],
		},
		product: {
			title: 'Add Finished Product',
			fields: [
				{ id: 'product', label: 'Product Name', type: 'select', required: true, options: ['Mobile water (500ML)'] },
				{ id: 'qty', label: 'Quantity', type: 'number', min: '0', required: true },
				{ id: 'location', label: 'Location', type: 'text', placeholder: 'Warehouse A' },
				{ id: 'date', label: 'Date', type: 'date', defaultValue: todayForInput, required: true },
			],
		},
		equipment: {
			title: 'Add Equipment',
			fields: [
				{ id: 'equipmentName', label: 'Equipment Name', type: 'text', required: true },
				{ id: 'details', label: 'Details', type: 'text' },
				{ id: 'lastMaintenance', label: 'Last Maintenance Date', type: 'date', defaultValue: todayForInput, required: true },
				{ id: 'nextMaintenance', label: 'Next Maintenance Date', type: 'date', required: true },
			],
		},
		customer: {
			title: 'Add Customer',
			fields: [
				{ id: 'name', label: 'Customer Name', type: 'text', required: true },
				{ id: 'contact', label: 'Contact', type: 'text', placeholder: '000-000-0000' },
				{ id: 'lastOrder', label: 'Last Order Date', type: 'date' },
			],
		},
	};

	const addModal = document.getElementById('inv-add-modal');
	const modalTitle = document.getElementById('inv-modal-title');
	const modalFieldsEl = document.getElementById('inv-modal-fields');
	const modalForm = document.getElementById('inv-add-form');
	let currentEntity = null;
	let editingIdx = -1;

	/* clearInvDraft / saveInvDraft / restoreInvDraft — invDraftKey and getInvDraft already declared above */
	const clearInvDraft = (entity) => { localStorage.removeItem(invDraftKey(entity)); };
	const saveInvDraft = (entity) => {
		const config = MODAL_CONFIGS[entity];
		if (!config) return;
		const data = {};
		config.fields.forEach((f) => {
			const el = document.getElementById(`inv-field-${f.id}`);
			if (el) data[f.id] = el.value;
		});
		localStorage.setItem(invDraftKey(entity), JSON.stringify(data));
	};
	const restoreInvDraft = (entity) => {
		const draft = getInvDraft(entity);
		if (!draft) return;
		const config = MODAL_CONFIGS[entity];
		if (!config) return;
		config.fields.forEach((f) => {
			const el = document.getElementById(`inv-field-${f.id}`);
			if (el && draft[f.id] !== undefined) el.value = draft[f.id];
		});
	};
	const bindInvModalLiveHandlers = () => {
		if (!modalFieldsEl || !currentEntity) return;
		modalFieldsEl.querySelectorAll('input, select, textarea').forEach((el) => {
			el.addEventListener('input', () => { if (editingIdx < 0) saveInvDraft(currentEntity); }, { passive: true });
		});
	};


	const closeModal = (skipDraft = false) => {
		invTrace('modal:close', { entity: currentEntity, editingIdx, skipDraft: !!skipDraft });
		const savedEntity = currentEntity;
		const wasAdding = editingIdx < 0;
		if (!skipDraft && wasAdding && savedEntity) saveInvDraft(savedEntity);
		if (addModal) addModal.style.display = 'none';
		if (modalForm) modalForm.reset();
		currentEntity = null;
		editingIdx = -1;
		if (wasAdding && savedEntity) rerenderInventory();
	};

	window.addEventListener('beforeunload', () => { if (editingIdx < 0 && currentEntity) saveInvDraft(currentEntity); });

	const openModal = (entity, editIndex, resumeDraft = false) => {
		invTrace('modal:open', { entity, editIndex: typeof editIndex === 'number' ? editIndex : -1, resumeDraft: !!resumeDraft });
		const config = MODAL_CONFIGS[entity];
		if (!config || !addModal) return;
		currentEntity = entity;
		editingIdx = typeof editIndex === 'number' ? editIndex : -1;
		if (modalTitle) modalTitle.textContent = editingIdx >= 0 ? config.title.replace('Add', 'Edit') : config.title;
		if (modalFieldsEl) {
			modalFieldsEl.innerHTML = config.fields.map((f) => {
				if (f.type === 'select') {
					return `
						<div class="inv-modal-field">
							<label for="inv-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label>
							<select id="inv-field-${f.id}" name="${f.id}" ${f.required ? 'required' : ''}>
								${(Array.isArray(f.options) ? f.options : []).map((o) => `<option value="${o}"${f.defaultValue !== undefined && String(f.defaultValue) === String(o) ? ' selected' : ''}>${o}</option>`).join('')}
							</select>
						</div>
					`;
				}
				return `
					<div class="inv-modal-field">
						<label for="inv-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label>
						<input
							id="inv-field-${f.id}"
							type="${f.type}"
							name="${f.id}"
							${f.required ? 'required' : ''}
							${f.min !== undefined ? `min="${f.min}"` : ''}
							${f.placeholder ? `placeholder="${f.placeholder}"` : ''}
							${f.defaultValue ? `value="${f.defaultValue}"` : ''}
						>
					</div>
				`;
			}).join('');
		}
		/* Pre-fill when editing */
		if (editingIdx >= 0) {
			let row;
			if (entity === 'material') row = rawMaterials[editingIdx];
			else if (entity === 'product') row = finishedProducts[editingIdx];
			else if (entity === 'equipment') row = equipment[editingIdx];
			else if (entity === 'customer') row = customers[editingIdx];
			if (row) {
				config.fields.forEach((f) => {
					const el = document.getElementById(`inv-field-${f.id}`);
					if (!el) return;
					if (entity === 'equipment' && f.id === 'equipmentName') el.value = row.equipment || '';
					else if (row[f.id] !== undefined) el.value = row[f.id];
				});
			}
		}
		if (resumeDraft) restoreInvDraft(entity);
		addModal.style.display = 'flex';
		const firstInput = modalFieldsEl && modalFieldsEl.querySelector('input, select');
		if (firstInput) firstInput.focus();
		bindInvModalLiveHandlers();
	};

	document.getElementById('inv-modal-close')?.addEventListener('click', closeModal);
	document.getElementById('inv-modal-cancel')?.addEventListener('click', closeModal);
	addModal?.addEventListener('click', (e) => { if (e.target === addModal) closeModal(); });

	if (modalForm && !modalForm.dataset.bound) {
		modalForm.dataset.bound = '1';
		modalForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			if (!currentEntity) return;
			invTrace('modal:submit:start', { entity: currentEntity, editingIdx, month: currentInventoryMonth });

			const getValue = (id) => {
				const el = document.getElementById(`inv-field-${id}`);
				return el ? el.value.trim() : '';
			};
			const getNum = (id) => {
				const v = Number(getValue(id));
				return Number.isFinite(v) && v >= 0 ? v : 0;
			};

			if (currentEntity === 'material') {
				const material = getValue('material');
				if (!material) return;
				if (editingIdx >= 0 && rawMaterials[editingIdx]) {
					rawMaterials[editingIdx].material = material;
					rawMaterials[editingIdx].quantity = getNum('quantity');
					rawMaterials[editingIdx].minLevel = getNum('minLevel');
					rawMaterials[editingIdx].supplier = getValue('supplier') || 'N/A';
					rawMaterials[editingIdx].restocked = getValue('restocked') || todayForInput;
				} else {
					rawMaterials.push({
						id: nextNumericId(rawMaterials),
						material,
						quantity: getNum('quantity'),
						minLevel: getNum('minLevel'),
						supplier: getValue('supplier') || 'N/A',
						restocked: getValue('restocked') || todayForInput,
					});
				}
				persistInventoryMonthState();
			}

			if (currentEntity === 'product') {
				const product = getValue('product');
				if (!product) return;
				invTrace('product:submit', { mode: editingIdx >= 0 ? 'edit' : 'add', editingIdx, beforeCount: finishedProducts.length, product });
				if (editingIdx >= 0 && finishedProducts[editingIdx]) {
					finishedProducts[editingIdx].product = product;
					finishedProducts[editingIdx].qty = getNum('qty');
					finishedProducts[editingIdx].location = getValue('location') || 'Warehouse A';
					finishedProducts[editingIdx].date = getValue('date') || finishedProducts[editingIdx].date || finishedProducts[editingIdx].addedDate;
				} else {
					finishedProducts.push({
						id: nextNumericId(finishedProducts),
						product,
						qty: getNum('qty'),
						location: getValue('location') || 'Warehouse A',
						date: getValue('date') || getTodayDateStr(),
						status: 'ready for sale',
						addedDate: getTodayDateStr(),
					});
				}
				persistInventoryMonthState();
				invTrace('product:submit:done', { afterCount: finishedProducts.length, month: currentInventoryMonth });
			}

			if (currentEntity === 'equipment') {
				const equipmentName = getValue('equipmentName');
				if (!equipmentName) return;
				invTrace('equipment:submit', { mode: editingIdx >= 0 ? 'edit' : 'add', editingIdx, beforeCount: equipment.length, equipmentName });
				if (editingIdx >= 0 && equipment[editingIdx]) {
					equipment[editingIdx].equipment = equipmentName;
					equipment[editingIdx].details = getValue('details');
					equipment[editingIdx].lastMaintenance = getValue('lastMaintenance') || todayForInput;
					equipment[editingIdx].nextMaintenance = getValue('nextMaintenance') || todayForInput;
					const saved = await saveOneEquipmentToServer(equipment[editingIdx]);
					invTrace('equipment:submit:edit:server-save', {
						success: !!saved,
						id: equipment[editingIdx] && equipment[editingIdx].id ? String(equipment[editingIdx].id) : '',
					});
				} else {
					const code = `EQ-${String(equipment.length + 101).padStart(3, '0')}`;
					const newEq = {
						code,
						equipment: equipmentName,
						details: getValue('details'),
						status: 'operational',
						lastMaintenance: getValue('lastMaintenance') || todayForInput,
						nextMaintenance: getValue('nextMaintenance') || todayForInput,
					};
					// Push optimistically so it renders immediately, but hold off on
					// persisting to localStorage until the server returns the real ID.
					// Without the ID, saveOneEquipmentToServer can't PUT updates, and
					// a sync triggered before the .then() resolves would save an ID-less record.
					equipment.push(newEq);
					rerenderInventory();
					try {
						const r = await fetch(API_BASE + '/api/factory-equipment', {
							method: 'POST', credentials: 'include',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(newEq),
						});
						if (r.ok) {
							const result = await r.json();
							if (result && result.id) newEq.id = result.id;
							invTrace('equipment:submit:add:server-create', { success: true, id: result && result.id ? String(result.id) : '' });
						} else {
							showDeleteToast('Equipment save failed — please refresh and try again.');
							invTrace('equipment:submit:add:server-create', { success: false, httpStatus: r.status });
						}
					} catch (_err) {
						showDeleteToast('Could not reach server to save new equipment.');
						invTrace('equipment:submit:add:server-create', { success: false, networkError: true });
					}
					persistInventoryMonthState();
				}
				persistInventoryMonthState();
				invTrace('equipment:submit:done', { afterCount: equipment.length, month: currentInventoryMonth });
			}

			if (currentEntity === 'customer') {
				const name = getValue('name');
				if (!name) return;
				if (editingIdx >= 0 && customers[editingIdx]) {
					customers[editingIdx].name = name;
					customers[editingIdx].contact = getValue('contact') || '000-000-0000';
					customers[editingIdx].lastOrder = getValue('lastOrder') || '-';
				} else {
					customers.push({
						id: nextNumericId(customers),
						name,
						contact: getValue('contact') || '000-000-0000',
						orders: 0,
						lastOrder: getValue('lastOrder') || '-',
						status: 'active',
					});
				}
			}

			persistInventoryMonthState();
			const submittedEntity = currentEntity;
			clearInvDraft(submittedEntity);
			closeModal(true); // skipDraft=true — data already saved, don't re-save draft
			rerenderInventory();
			invTrace('modal:submit:done', { entity: submittedEntity, month: currentInventoryMonth });
		});
	}

	if (!document.__wwInventoryBound) {
		document.__wwInventoryBound = true;
		document.addEventListener('click', (event) => {
			const button = event.target.closest('.table-add-btn[data-add-entity]');
			if (button) {
				invTrace('click:add', { entity: button.getAttribute('data-add-entity') || '', canAdd: !!canAdd });
				if (!canAdd) {
					alert('You do not have permission to add rows.');
					return;
				}
				openModal(button.getAttribute('data-add-entity'), undefined, false);
				return;
			}
			const resumeDraftBtn = event.target.closest('.inv-resume-draft-btn[data-draft-entity]');
			if (resumeDraftBtn) { event.stopPropagation(); openModal(resumeDraftBtn.getAttribute('data-draft-entity'), undefined, true); return; }
			const clearDraftBtn = event.target.closest('.inv-clear-draft-btn[data-draft-entity]');
			if (clearDraftBtn) {
				event.stopPropagation();
				clearInvDraft(clearDraftBtn.getAttribute('data-draft-entity'));
				rerenderInventory();
				return;
			}
			const editBtn = event.target.closest('.inv-edit-btn');
			if (editBtn) {
				event.stopPropagation();
				invTrace('click:edit', {
					entity: editBtn.getAttribute('data-edit-entity') || '',
					idx: Number(editBtn.getAttribute('data-edit-idx')),
					month: currentInventoryMonth,
				});
				openModal(editBtn.getAttribute('data-edit-entity'), Number(editBtn.getAttribute('data-edit-idx')));
				return;
			}
			const deleteBtn = event.target.closest('.inv-delete-btn');
			if (deleteBtn) {
				event.stopPropagation();
				const entity = deleteBtn.getAttribute('data-delete-entity');
				const idx = Number(deleteBtn.getAttribute('data-delete-idx'));
				invTrace('click:delete', { entity, idx, month: currentInventoryMonth });
				if (!window.confirm('Delete this ' + entity + '? This cannot be undone.')) return;
				if (entity === 'material') {
					const removed = rawMaterials[idx];
					if (removed) moveAppDataDeleteToTrash('inventory', removed, { kind: 'appDataArray', key: 'ww_raw_materials' });
					rawMaterials.splice(idx, 1);
					persistInventoryMonthState();
				}
				else if (entity === 'product') {
					const removed = finishedProducts[idx];
					if (removed) moveAppDataDeleteToTrash('inventory', removed, { kind: 'appDataArray', key: 'ww_finished_products' });
					finishedProducts.splice(idx, 1);
					persistInventoryMonthState();
				}
				else if (entity === 'equipment') {
					const removed = equipment[idx];
					if (removed && !removed.id) {
						moveAppDataDeleteToTrash('factory-equipment', removed, { kind: 'appDataArray', key: 'ww_equipment' });
					}
					equipment.splice(idx, 1);
					if (removed && removed.id) {
						fetch(API_BASE + '/api/factory-equipment/' + removed.id, { method: 'DELETE', credentials: 'include' }).catch(() => {});
					}
					persistInventoryMonthState();
				}
				else if (entity === 'customer') { customers.splice(idx, 1); persistInventoryMonthState(); }
				rerenderInventory();
				const toastMsgs = { material: 'Raw material removed from inventory.', product: 'Finished product removed from inventory.', equipment: 'Equipment record deleted.', customer: 'Customer removed.' };
				if (toastMsgs[entity]) setTimeout(() => showDeleteToast(toastMsgs[entity]), 50);
			}
		});
	}

	/* ── Cross-tab sync: refresh inventory when another tab changes data ── */
	const reloadAndRerender = async () => {
		invTrace('sync:reload:start', { month: currentInventoryMonth });
		await loadInventoryMonthState(currentInventoryMonth);
		renderInventoryMonthOptions();
		rerenderInventory();
		invTrace('sync:reload:done', { month: currentInventoryMonth });
	};
	window.addEventListener('storage', (e) => {
		invTrace('sync:storage-event', { key: e && e.key ? String(e.key) : '' });
		if ([
			'ww_raw_materials',
			'ww_finished_products',
			'ww_equipment',
			INVENTORY_MONTHS_KEY,
			inventoryMonthStorageKey(currentInventoryMonth),
		].includes(e.key)) {
			reloadAndRerender().catch(() => {});
		}
	});
	try {
		new BroadcastChannel('ww_raw_materials_sync').onmessage = () => {
			invTrace('sync:channel', { channel: 'ww_raw_materials_sync' });
			reloadAndRerender().catch(() => {});
		};
		new BroadcastChannel('ww_finished_products_sync').onmessage = () => {
			invTrace('sync:channel', { channel: 'ww_finished_products_sync' });
			reloadAndRerender().catch(() => {});
		};
		// Equipment sync: fetch fresh from server rather than reloading the monthly
		// snapshot (which doesn't contain the dashboard's status changes — they only
		// update ww_equipment, not the monthly key).
		new BroadcastChannel('ww_equipment_sync').onmessage = async () => {
			invTrace('sync:channel', { channel: 'ww_equipment_sync' });
			equipment = await fetchEquipmentFromServer();
			rerenderInventory();
		};
	} catch (_e) { /* BroadcastChannel not supported */ }
	document.addEventListener('ww-refresh-page', rerenderInventory);
}

const salesModuleData = {
	invoices: [],
	salesOrders: [],
};

/* ── Monthly storage helpers ── */
const MONTHS_KEY = 'ww_sales_months';
let currentSalesMonth = '';

function getSalesMonths() {
	try {
		const parsed = JSON.parse(localStorage.getItem(MONTHS_KEY) || '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch (_e) {
		return [];
	}
}

function saveSalesMonths(months) {
	localStorage.setItem(MONTHS_KEY, JSON.stringify(months));
	syncToServer(MONTHS_KEY, months);
}

function monthStorageKey(month) {
	return `ww_sales_${month}`;
}

function getSalesYearPayloads(year) {
	const normalizedYear = String(year || '').trim();
	if (!/^\d{4}$/.test(normalizedYear)) return [];
	return recoverSalesMonthsFromStorage()
		.filter((month) => String(month || '').slice(0, 4) === normalizedYear)
		.map((month) => {
			const payload = getSalesMonthPayload(month);
			return payload && typeof payload === 'object' ? payload : null;
		})
		.filter(Boolean);
}

function getAvailableInvoiceProducts(preferredProduct) {
	const options = [];
	const seen = new Set();
	const addOption = (value) => {
		const normalized = String(value || '').trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		options.push(normalized);
	};

	addOption(preferredProduct);
	addOption('Mobile water (500ML)');
	addOption('500ml Sachet Water (500 pcs/bag)');

	try {
		const finishedProducts = JSON.parse(localStorage.getItem('ww_finished_products') || '[]');
		if (Array.isArray(finishedProducts)) {
			finishedProducts.forEach((row) => {
				if (row && typeof row === 'object') addOption(row.product || row.name);
			});
		}
	} catch (_e) { /* ignore */ }

	return options.length ? options : ['Mobile water (500ML)'];
}

function recoverSalesMonthsFromStorage() {
	const existing = getSalesMonths();
	const recovered = new Set(existing);
	for (let i = 0; i < localStorage.length; i += 1) {
		const key = localStorage.key(i);
		if (!key) continue;
		const match = /^ww_sales_(\d{4}-\d{2})$/.exec(key);
		if (match && match[1]) recovered.add(match[1]);
	}
	const merged = Array.from(recovered).sort();
	if (merged.length !== existing.length || merged.some((m, idx) => m !== existing[idx])) {
		saveSalesMonths(merged);
	}
	return merged;
}

function monthLabel(month) {
	const [y, m] = month.split('-');
	const names = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
	return `${names[parseInt(m, 10)] || m} ${y}`;
}

function getInvoiceMonth(invoice) {
	const raw = String(invoice?.date || invoice?.orderDate || '').trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
	return raw.slice(0, 7);
}

function shouldEnforceMonthDateFilter(month) {
	return !getLockedSalesMonthConfig(month);
}

function isInvoiceInMonthBucket(inv, month) {
	if (!inv || !inv.id) return false;
	if (!month) return true;
	const id = String(inv.id || '').trim();
	if (id.startsWith(`INV-${month}-`)) return true;
	return getInvoiceMonth(inv) === month;
}

function normalizeMonthInvoices(month, invoices) {
	const keep = [];
	const movedByMonth = {};
	const seenSignatures = new Set();
	const enforceDateFilter = shouldEnforceMonthDateFilter(month);
	for (const inv of Array.isArray(invoices) ? invoices : []) {
		if (!inv || !inv.id) continue;
		const invMonth = getInvoiceMonth(inv);
		if (enforceDateFilter && invMonth && invMonth !== month) {
			if (!movedByMonth[invMonth]) movedByMonth[invMonth] = [];
			movedByMonth[invMonth].push(inv);
			continue;
		}
		const sig = invoiceSignature(inv);
		if (sig && seenSignatures.has(sig)) continue;
		if (sig) seenSignatures.add(sig);
		keep.push(inv);
	}
	return { keep, movedByMonth };
}

function normalizeMonthSalesRecords(month, invoices, orders) {
	const invoiceResult = normalizeMonthInvoices(month, invoices);
	const keepInvoices = invoiceResult.keep;
	const movedByMonth = {};
	const enforceDateFilter = shouldEnforceMonthDateFilter(month);
	const invoiceById = new Map(keepInvoices.map((inv) => [String(inv.id), inv]));
	const movedInvoiceById = new Map();
	for (const [targetMonth, movedInvoices] of Object.entries(invoiceResult.movedByMonth || {})) {
		if (!Array.isArray(movedInvoices) || !movedInvoices.length) continue;
		movedByMonth[targetMonth] = movedByMonth[targetMonth] || [];
		movedInvoices.forEach((inv) => {
			if (!inv || !inv.id) return;
			movedInvoiceById.set(String(inv.id), { targetMonth, invoice: inv });
			movedByMonth[targetMonth].push({ invoice: inv, order: null });
		});
	}
	const keepOrders = (Array.isArray(orders) ? orders : []).filter((ord) => {
		if (!ord || !ord.id) return false;
		const sourceInvoiceId = String(ord.sourceInvoiceId || '').trim();
		if (sourceInvoiceId && movedInvoiceById.has(sourceInvoiceId)) {
			const moved = movedInvoiceById.get(sourceInvoiceId);
			if (moved && moved.targetMonth) {
				const rows = movedByMonth[moved.targetMonth] || [];
				const row = rows.find((r) => r && r.invoice && String(r.invoice.id) === sourceInvoiceId);
				if (row) row.order = ord;
			}
			return false;
		}
		const linkedInvoice = sourceInvoiceId ? invoiceById.get(sourceInvoiceId) : null;
		if (linkedInvoice) return true;
		const derivedInvoiceId = `INV${String(ord.id || '').slice(2)}`;
		if (movedInvoiceById.has(derivedInvoiceId)) {
			const moved = movedInvoiceById.get(derivedInvoiceId);
			if (moved && moved.targetMonth) {
				const rows = movedByMonth[moved.targetMonth] || [];
				const row = rows.find((r) => r && r.invoice && String(r.invoice.id) === derivedInvoiceId);
				if (row) row.order = ord;
			}
			return false;
		}
		if (invoiceById.has(derivedInvoiceId)) return true;
		const ordMonth = getInvoiceMonth(ord);
		if (!enforceDateFilter) return true;
		return !ordMonth || ordMonth === month;
	});
	return { keepInvoices, keepOrders, movedByMonth };
}

function mergeSalesRecordsIntoMonth(month, invoices, orders) {
	if (!month) return false;
	const invoiceList = Array.isArray(invoices) ? invoices.filter((inv) => inv && inv.id) : [];
	const orderList = Array.isArray(orders) ? orders.filter((ord) => ord && ord.id) : [];
	if (!invoiceList.length && !orderList.length) return false;
	const payload = getSalesMonthPayload(month);
	const existingInvs = Array.isArray(payload.invoices) ? payload.invoices : [];
	const existingOrds = Array.isArray(payload.salesOrders) ? payload.salesOrders : [];
	const deletedInv = new Set(normalizeIdArray(payload.deletedInvoiceIds));
	const deletedOrd = new Set(normalizeIdArray(payload.deletedOrderIds));
	const existingIds = new Set(existingInvs.map((inv) => String(inv?.id || '')).filter(Boolean));
	const existingOrderIds = new Set(existingOrds.map((ord) => String(ord?.id || '')).filter(Boolean));
	const nextInvoices = [...existingInvs];
	const nextOrders = [...existingOrds];
	let changed = false;
	for (const inv of invoiceList) {
		const id = String(inv.id);
		if (deletedInv.has(id) || existingIds.has(id)) continue;
		nextInvoices.push(inv);
		existingIds.add(id);
		changed = true;
	}
	for (const ord of orderList) {
		const id = String(ord.id);
		if (deletedOrd.has(id) || existingOrderIds.has(id)) continue;
		nextOrders.push(ord);
		existingOrderIds.add(id);
		changed = true;
	}
	if (!changed) return false;
	const nextPayload = {
		...payload,
		invoices: nextInvoices,
		salesOrders: nextOrders,
		deletedInvoiceIds: normalizeIdArray(payload.deletedInvoiceIds),
		deletedOrderIds: normalizeIdArray(payload.deletedOrderIds),
	};
	localStorage.setItem(monthStorageKey(month), JSON.stringify(nextPayload));
	setProtectedSalesPayload(month, nextPayload);
	queuePendingSalesSync(month, nextPayload);
	return true;
}

function mergeInvoicesIntoMonthStorage(month, invoices) {
	if (!month || !Array.isArray(invoices) || !invoices.length) return false;
	ensureMonthExists(month);
	const payload = getSalesMonthPayload(month);
	const existingInvs = Array.isArray(payload.invoices) ? payload.invoices : [];
	const deletedInv = new Set(normalizeIdArray(payload.deletedInvoiceIds));
	const existingIds = new Set(existingInvs.map((inv) => String(inv?.id || '')).filter(Boolean));
	const existingSigs = new Set(existingInvs.map((inv) => invoiceSignature(inv)).filter(Boolean));
	const additions = [];
	for (const inv of invoices) {
		if (!inv || !inv.id) continue;
		const id = String(inv.id);
		if (deletedInv.has(id)) continue;
		const sig = invoiceSignature(inv);
		if (existingIds.has(id) || (sig && existingSigs.has(sig))) continue;
		additions.push(inv);
		existingIds.add(id);
		if (sig) existingSigs.add(sig);
	}
	if (!additions.length) return false;
	const nextPayload = {
		...payload,
		invoices: [...existingInvs, ...additions],
		salesOrders: Array.isArray(payload.salesOrders) ? payload.salesOrders : [],
		deletedInvoiceIds: normalizeIdArray(payload.deletedInvoiceIds),
		deletedOrderIds: normalizeIdArray(payload.deletedOrderIds),
	};
	localStorage.setItem(monthStorageKey(month), JSON.stringify(nextPayload));
	queuePendingSalesSync(month, nextPayload);
	const snapshot = {
		invoices: [...nextPayload.invoices],
		salesOrders: [...nextPayload.salesOrders],
		deletedInvoiceIds: [...nextPayload.deletedInvoiceIds],
		deletedOrderIds: [...nextPayload.deletedOrderIds],
	};
	mergeSyncSalesMonth(month, snapshot).then((ok) => {
		if (ok) clearPendingSalesSync(month);
	});
	return true;
}

/** Aggregate invoices + salesOrders across ALL months (used by Dashboard, Reports, etc.) */
function getAllSalesData() {
	const months = recoverSalesMonthsFromStorage();
	const allInvoices = [];
	const allOrders = [];
	const seenOrderIds = new Set();
	const seenOrderSignatures = new Set();
	for (const m of months) {
		try {
			const stored = getSalesMonthPayload(m);
			if (stored && typeof stored === 'object') {
				if (Array.isArray(stored.invoices)) {
					// Dedup within this month only — do NOT skip invoices whose ID
					// appeared in an earlier month bucket, because the year-resequence
					// migration can assign the same INV-YEAR-NNN number to different
					// invoices in different months (they are distinct records).
					const seenInMonthIds = new Set();
					for (const inv of stored.invoices) {
						if (!inv || !inv.id) continue;
						const id = String(inv.id);
						if (seenInMonthIds.has(id)) continue;
						seenInMonthIds.add(id);
						allInvoices.push(inv);
					}
				}
				const monthInvoiceIds = new Set((Array.isArray(stored.invoices) ? stored.invoices : []).map((inv) => String(inv?.id || '')).filter(Boolean));
				if (Array.isArray(stored.salesOrders)) {
					for (const ord of stored.salesOrders) {
						if (!ord || !ord.id) continue;
						if (ord.sourceInvoiceId && !monthInvoiceIds.has(String(ord.sourceInvoiceId))) continue;
						const id = String(ord.id);
						if (seenOrderIds.has(id)) continue;
						const sig = orderSignature(ord);
						if (sig && seenOrderSignatures.has(sig)) continue;
						seenOrderIds.add(id);
						if (sig) seenOrderSignatures.add(sig);
						allOrders.push(ord);
					}
				}
			}
		} catch (_e) { /* skip */ }
	}
	return { invoices: allInvoices, salesOrders: allOrders };
}

function ensureMonthExists(month) {
	const months = getSalesMonths();
	if (!months.includes(month)) {
		months.push(month);
		months.sort();
		saveSalesMonths(months);
	}
}

function dedupeSalesMonthPayload(payload) {
	const base = payload && typeof payload === 'object' ? payload : {};
	const invoices = Array.isArray(base.invoices) ? base.invoices : [];
	const salesOrders = Array.isArray(base.salesOrders) ? base.salesOrders : [];
	const dedupedInvoices = [];
	const seenInvoiceIds = new Set();
	const seenInvoiceSignatures = new Set();
	for (const inv of invoices) {
		if (!inv || !inv.id) continue;
		const id = String(inv.id);
		if (seenInvoiceIds.has(id)) continue;
		const sig = invoiceSignature(inv);
		if (sig && seenInvoiceSignatures.has(sig)) continue;
		dedupedInvoices.push(inv);
		seenInvoiceIds.add(id);
		if (sig) seenInvoiceSignatures.add(sig);
	}

	const activeInvoiceIds = new Set(dedupedInvoices.map((inv) => String(inv.id || '')).filter(Boolean));
	const dedupedOrders = [];
	const seenOrderIds = new Set();
	const seenOrderSignatures = new Set();
	for (const ord of salesOrders) {
		if (!ord || !ord.id) continue;
		const id = String(ord.id);
		if (seenOrderIds.has(id)) continue;
		if (ord.sourceInvoiceId && !activeInvoiceIds.has(String(ord.sourceInvoiceId))) continue;
		const sig = orderSignature(ord);
		if (sig && seenOrderSignatures.has(sig)) continue;
		dedupedOrders.push(ord);
		seenOrderIds.add(id);
		if (sig) seenOrderSignatures.add(sig);
	}

	const deletedInvoiceIds = normalizeIdArray(base.deletedInvoiceIds);
	const deletedOrderIds = normalizeIdArray(base.deletedOrderIds);
	return {
		...base,
		invoices: dedupedInvoices,
		salesOrders: dedupedOrders,
		deletedInvoiceIds,
		deletedOrderIds,
	};
}

function repairSalesMonthConsistency(month) {
	if (!month) return { beforeInvoices: 0, afterInvoices: 0, beforeOrders: 0, afterOrders: 0 };
	const current = getSalesMonthPayload(month);
	const protectedPayload = getProtectedSalesPayload(month);
	const mergedDeletedInv = [...new Set([
		...(Array.isArray(current && current.deletedInvoiceIds) ? current.deletedInvoiceIds : []),
		...(Array.isArray(protectedPayload && protectedPayload.deletedInvoiceIds) ? protectedPayload.deletedInvoiceIds : []),
	].map(String))];
	const base = { ...(current && typeof current === 'object' ? current : {}), deletedInvoiceIds: mergedDeletedInv };

	const beforeInvoices = Array.isArray(current.invoices) ? current.invoices.length : 0;
	const beforeOrders = Array.isArray(current.salesOrders) ? current.salesOrders.length : 0;
	const deduped = dedupeSalesMonthPayload(base);
	const repairedDeletedIds = new Set((Array.isArray(deduped.deletedInvoiceIds) ? deduped.deletedInvoiceIds : []).map(String));
	const invoices = (Array.isArray(deduped.invoices) ? deduped.invoices : []).filter((inv) => inv && inv.id && !repairedDeletedIds.has(String(inv.id)));
	const existingOrders = (Array.isArray(deduped.salesOrders) ? deduped.salesOrders : []).filter((ord) => ord && ord.id);

	invoices.sort((a, b) => {
		const da = new Date(a.date || a.orderDate || a.createdAt || 0).getTime();
		const db = new Date(b.date || b.orderDate || b.createdAt || 0).getTime();
		const ta = Number.isNaN(da) ? Number.MAX_SAFE_INTEGER : da;
		const tb = Number.isNaN(db) ? Number.MAX_SAFE_INTEGER : db;
		if (ta !== tb) return ta - tb;
		return String(a.id || '').localeCompare(String(b.id || ''));
	});

	const rebuiltOrders = invoices.map((inv) => {
		const soId = `SO${String(inv.id || '').slice(3)}`;
		const existing = existingOrders.find((o) => String(o?.sourceInvoiceId || '') === String(inv.id) || String(o?.id || '') === soId) || {};
		const firstItem = Array.isArray(inv.items) && inv.items[0] ? inv.items[0] : null;
		const qty = Number((firstItem && firstItem.qty) || inv.bags || existing.bags || 0);
		const rate = Number((firstItem && firstItem.unitPrice) || inv.rate || existing.rate || 0);
		return {
			...existing,
			id: soId,
			sourceInvoiceId: inv.id,
			customer: inv.customer,
			orderDate: inv.date || inv.orderDate,
			deliveryDate: inv.date || inv.orderDate,
			amount: Number(inv.amount || qty * rate || 0),
			status: inv.status || existing.status || 'pending',
			bags: qty,
			rate,
			promo: Number(inv.promo || 0),
			promoNote: inv.promoNote || existing.promoNote || '',
			paymentMode: inv.paymentMode || existing.paymentMode || '',
			carType: inv.carType || existing.carType || '',
			carNumber: inv.carNumber || existing.carNumber || '',
			paidDate: inv.paidDate || existing.paidDate || '',
			items: Array.isArray(inv.items) ? JSON.parse(JSON.stringify(inv.items)) : (Array.isArray(existing.items) ? JSON.parse(JSON.stringify(existing.items)) : []),
		};
	});

	const activeInvoiceIds = new Set(invoices.map((inv) => String(inv.id)));
	const activeOrderIds = new Set(rebuiltOrders.map((ord) => String(ord.id)));
	const repaired = {
		...deduped,
		invoices,
		salesOrders: rebuiltOrders,
		deletedInvoiceIds: normalizeIdArray(deduped.deletedInvoiceIds).filter((id) => !activeInvoiceIds.has(String(id))),
		deletedOrderIds: normalizeIdArray(deduped.deletedOrderIds).filter((id) => !activeOrderIds.has(String(id))),
	};

	localStorage.setItem(monthStorageKey(month), JSON.stringify(repaired));
	setProtectedSalesPayload(month, repaired);
	if (String(currentSalesMonth) === String(month)) {
		salesModuleData.invoices = JSON.parse(JSON.stringify(repaired.invoices || []));
		salesModuleData.salesOrders = JSON.parse(JSON.stringify(repaired.salesOrders || []));
		saveSalesDataToStorage();
	} else {
		queuePendingSalesSync(month, repaired);
		const snapshot = {
			invoices: [...(repaired.invoices || [])],
			salesOrders: [...(repaired.salesOrders || [])],
			deletedInvoiceIds: [...(repaired.deletedInvoiceIds || [])],
			deletedOrderIds: [...(repaired.deletedOrderIds || [])],
		};
		mergeSyncSalesMonth(month, snapshot).then((ok) => {
			if (ok) clearPendingSalesSync(month);
		});
	}

	return {
		beforeInvoices,
		afterInvoices: repaired.invoices.length,
		beforeOrders,
		afterOrders: repaired.salesOrders.length,
	};
}

function runOneTimeSalesMonthDedupeMigration() {
	if (localStorage.getItem(SALES_MONTH_DEDUPE_MIGRATION_KEY) === '1') return;
	const months = recoverSalesMonthsFromStorage();
	for (const month of months) {
		if (getLockedSalesMonthConfig(month)) continue;
		const storageKey = monthStorageKey(month);
		let payload = null;
		try {
			payload = JSON.parse(localStorage.getItem(storageKey) || 'null');
		} catch (_e) {
			payload = null;
		}
		if (!payload || typeof payload !== 'object') continue;
		const deduped = dedupeSalesMonthPayload(payload);
		if (JSON.stringify(deduped) === JSON.stringify(payload)) continue;
		localStorage.setItem(storageKey, JSON.stringify(deduped));
		setProtectedSalesPayload(month, deduped);
		queuePendingSalesSync(month, deduped);
	}
	localStorage.setItem(SALES_MONTH_DEDUPE_MIGRATION_KEY, '1');
}

function runOneTimeSalesYearResequenceMigration() {
	if (localStorage.getItem(SALES_YEAR_RESEQUENCE_MIGRATION_KEY) === '1') return;

	const resolveInvoiceLinkFromOrder = (ord) => {
		if (!ord) return '';
		const source = String(ord.sourceInvoiceId || '').trim();
		if (source) return source;
		const m = String(ord.id || '').match(/^SO-(\d{4})(?:-(\d{2}))?-(\d{3})$/);
		if (!m) return '';
		return m[2] ? `INV-${m[1]}-${m[2]}-${m[3]}` : `INV-${m[1]}-${m[3]}`;
	};
	const getIdNum = (id) => {
		const m = String(id || '').match(/(\d+)$/);
		return m ? Number(m[1]) : 0;
	};
	const payloadsByYear = new Map();

	recoverSalesMonthsFromStorage().forEach((month) => {
		if (getLockedSalesMonthConfig(month)) return;
		const payload = getSalesMonthPayload(month);
		if (!payload || typeof payload !== 'object') return;
		const year = String(month || '').slice(0, 4);
		if (!/^\d{4}$/.test(year)) return;
		const bucket = payloadsByYear.get(year) || [];
		bucket.push({ month, payload });
		payloadsByYear.set(year, bucket);
	});

	payloadsByYear.forEach((entries, year) => {
		const invoiceRows = entries.flatMap(({ month, payload }) => {
			const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
			return invoices
				.filter((inv) => inv && inv.id)
				.map((inv) => ({ month, inv }));
		});

		invoiceRows.sort((a, b) => {
			const aDate = String(a.inv?.date || a.inv?.orderDate || a.inv?.createdAt || '');
			const bDate = String(b.inv?.date || b.inv?.orderDate || b.inv?.createdAt || '');
			const dateDiff = aDate.localeCompare(bDate);
			if (dateDiff !== 0) return dateDiff;
			const monthDiff = String(a.month || '').localeCompare(String(b.month || ''));
			if (monthDiff !== 0) return monthDiff;
			return getIdNum(a.inv?.id) - getIdNum(b.inv?.id);
		});

		const invoiceIdMapByMonth = new Map();
		invoiceRows.forEach(({ month, inv }, index) => {
			const oldId = String(inv.id || '');
			const newId = `INV-${year}-${String(index + 1).padStart(3, '0')}`;
			inv.id = newId;
			const monthMap = invoiceIdMapByMonth.get(month) || new Map();
			monthMap.set(oldId, newId);
			invoiceIdMapByMonth.set(month, monthMap);
		});

		entries.forEach(({ month, payload }) => {
			const monthMap = invoiceIdMapByMonth.get(month) || new Map();
			const orders = Array.isArray(payload.salesOrders) ? payload.salesOrders : [];
			orders.forEach((ord) => {
				const sourceInvoiceId = resolveInvoiceLinkFromOrder(ord);
				const mappedInvId = monthMap.get(String(sourceInvoiceId || ''));
				if (!mappedInvId) return;
				ord.sourceInvoiceId = mappedInvId;
				ord.id = `SO${String(mappedInvId).slice(3)}`;
			});

			const activeInvoiceIds = new Set((Array.isArray(payload.invoices) ? payload.invoices : []).map((inv) => String(inv?.id || '')).filter(Boolean));
			const activeOrderIds = new Set(orders.map((ord) => String(ord?.id || '')).filter(Boolean));
			payload.deletedInvoiceIds = normalizeIdArray(payload.deletedInvoiceIds).filter((id) => !activeInvoiceIds.has(String(id)));
			payload.deletedOrderIds = normalizeIdArray(payload.deletedOrderIds).filter((id) => !activeOrderIds.has(String(id)));

			localStorage.setItem(monthStorageKey(month), JSON.stringify(payload));
			setProtectedSalesPayload(month, payload);
			queuePendingSalesSync(month, payload);
		});
	});

	localStorage.setItem(SALES_YEAR_RESEQUENCE_MIGRATION_KEY, '1');
}

function runOneTimeMayResetMigration() {
	try {
		// Historical migration intentionally disabled. Keep existing month data intact.
		if (!localStorage.getItem(MAY_RESET_MIGRATION_KEY)) {
			localStorage.setItem(MAY_RESET_MIGRATION_KEY, '1');
		}
	} catch (_e) { /* ignore */ }
}

function loadSalesDataFromStorage() {
	/* Clean up any old key */
	try { localStorage.removeItem('ww_sales_data'); } catch(_e) {}

	/* Recover month index from available monthly keys */
	recoverSalesMonthsFromStorage();
	runOneTimeSalesMonthDedupeMigration();

	/* March entries are editable and persistent; no automatic month cleanup here. */
	runOneTimeMayResetMigration();

	runOneTimeSalesYearResequenceMigration();

	/* Pick the month to display */
	if (!currentSalesMonth) {
		const now = new Date();
		const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
		const allMonths = getSalesMonths();
		currentSalesMonth = allMonths.includes(thisMonth) ? thisMonth : (allMonths[allMonths.length - 1] || thisMonth);
		if (!allMonths.length) {
			ensureMonthExists(thisMonth);
		}
	}

	loadMonthData(currentSalesMonth);
}

function loadMonthData(month) {
	currentSalesMonth = month;
	salesModuleData.invoices = [];
	salesModuleData.salesOrders = [];
	let dirty = false;
	enforceLockedSalesPayload(month);
	try {
		const stored = getSalesMonthPayload(month);
		if (stored && typeof stored === 'object') {
			const rawInvoices = (Array.isArray(stored.invoices) ? stored.invoices : []).filter((inv) => inv && inv.id);
			const rawOrders = (Array.isArray(stored.salesOrders) ? stored.salesOrders : []).filter((ord) => ord && ord.id);
			const normalizedMonthRecords = normalizeMonthSalesRecords(month, rawInvoices, rawOrders);
			if (normalizedMonthRecords.keepInvoices.length !== rawInvoices.length || normalizedMonthRecords.keepOrders.length !== rawOrders.length) {
				dirty = true;
			}
			if (Object.keys(normalizedMonthRecords.movedByMonth || {}).length) {
				for (const [targetMonth, movedRows] of Object.entries(normalizedMonthRecords.movedByMonth)) {
					const movedInvoices = movedRows.map((row) => row.invoice).filter(Boolean);
					const movedOrders = movedRows.map((row) => row.order).filter(Boolean);
					mergeSalesRecordsIntoMonth(targetMonth, movedInvoices, movedOrders);
				}
				dirty = true;
			}
			const activeInvoiceIds = new Set(normalizedMonthRecords.keepInvoices.map((inv) => String(inv.id)));
			const activeOrderIds = new Set(normalizedMonthRecords.keepOrders.map((ord) => String(ord.id)));
			const normalizedDeletedInv = normalizeIdArray(stored.deletedInvoiceIds).map((id) => String(id));
			const normalizedDeletedOrd = normalizeIdArray(stored.deletedOrderIds).map((id) => String(id));
			const reconciledDeletedInv = normalizedDeletedInv.filter((id) => !activeInvoiceIds.has(id));
			const reconciledDeletedOrd = normalizedDeletedOrd.filter((id) => !activeOrderIds.has(id));
			if (reconciledDeletedInv.length !== normalizedDeletedInv.length || reconciledDeletedOrd.length !== normalizedDeletedOrd.length) {
				stored.deletedInvoiceIds = reconciledDeletedInv;
				stored.deletedOrderIds = reconciledDeletedOrd;
				dirty = true;
			}
			const deletedInv = new Set(reconciledDeletedInv);
			const deletedOrd = new Set(reconciledDeletedOrd);
			salesModuleData.invoices = normalizedMonthRecords.keepInvoices.filter((inv) => !deletedInv.has(String(inv.id)));
			salesModuleData.salesOrders = normalizedMonthRecords.keepOrders.filter((ord) => {
				if (!ord || !ord.id) return false;
				if (deletedOrd.has(String(ord.id))) return false;
				if (ord.sourceInvoiceId && deletedInv.has(String(ord.sourceInvoiceId))) return false;
				return true;
			});
		}
	} catch (_e) { /* ignore */ }

	// Do not auto-move invoices to other months during page/month navigation.
	// Users may intentionally keep legacy entries in the selected month bucket.

	// Legacy cleanup: status "confirmed" in this module represents pending work.
	if (salesModuleData.invoices.length || salesModuleData.salesOrders.length) {
		salesModuleData.invoices.forEach((inv) => {
			if (inv && inv.status === 'confirmed') { inv.status = 'pending'; dirty = true; }
		});
		salesModuleData.salesOrders.forEach((ord) => {
			if (ord && ord.status === 'confirmed') { ord.status = 'pending'; dirty = true; }
		});
	}

	/* Keep invoice list arranged by date, but do NOT renumber existing IDs. */
	if (salesModuleData.invoices.length > 1) {
		salesModuleData.invoices.sort((a, b) => {
			const da = new Date(a.date || a.orderDate || a.createdAt || 0).getTime();
			const db = new Date(b.date || b.orderDate || b.createdAt || 0).getTime();
			const ta = Number.isNaN(da) ? Number.MAX_SAFE_INTEGER : da;
			const tb = Number.isNaN(db) ? Number.MAX_SAFE_INTEGER : db;
			return ta - tb;
		});
	}

	/* Keep Sales Orders strictly 1:1 with invoices (linked by sourceInvoiceId). */
	const existingOrders = Array.isArray(salesModuleData.salesOrders) ? salesModuleData.salesOrders : [];
	const normalizedOrders = salesModuleData.invoices.map((inv) => {
		const soId = 'SO' + String(inv.id || '').slice(3);
		const existing = existingOrders.find((o) => String(o?.sourceInvoiceId || '') === String(inv.id) || String(o?.id || '') === soId) || {};
		const firstItem = Array.isArray(inv.items) && inv.items[0] ? inv.items[0] : null;
		const qty = Number((firstItem && firstItem.qty) || inv.bags || 0);
		const rate = Number((firstItem && firstItem.unitPrice) || inv.rate || 0);
		return {
			...existing,
			id: soId,
			sourceInvoiceId: inv.id,
			customer: inv.customer,
			orderDate: inv.date || inv.orderDate,
			deliveryDate: inv.date || inv.orderDate,
			amount: Number(inv.amount || qty * rate || 0),
			status: inv.status || existing.status || 'pending',
			bags: qty,
			rate,
			promo: Number(inv.promo || 0),
			promoNote: inv.promoNote || '',
			paymentMode: inv.paymentMode || '',
			carType: inv.carType || '',
			carNumber: inv.carNumber || '',
			paidDate: inv.paidDate || '',
			items: Array.isArray(inv.items) ? JSON.parse(JSON.stringify(inv.items)) : [],
		};
	});
	if (salesModuleData.salesOrders.length !== normalizedOrders.length) dirty = true;
	salesModuleData.salesOrders = normalizedOrders;

	if (dirty) saveSalesDataToStorage();

}

function seedMarchSalesData() {
	const rows = [
		// 16/03/26
		{ d:'2026-03-16', c:'Mon (driver)', b:60, r:7.5, a:450, s:'paid' },
		{ d:'2026-03-16', c:'Mon (driver)', b:15, r:7.5, a:113, s:'paid' },
		{ d:'2026-03-16', c:'Charlotte', b:950, r:6, a:5700, s:'paid' },
		{ d:'2026-03-16', c:'JMK', b:745, r:0, a:1500, s:'paid' },
		// 17/03/26
		{ d:'2026-03-17', c:'Client', b:1, r:7.5, a:7.50, s:'paid' },
		{ d:'2026-03-17', c:'Charlotte', b:500, r:6, a:3000, s:'paid', pr:20 },
		{ d:'2026-03-17', c:'Musa', b:250, r:6.5, a:1500, s:'paid', pr:12 },
		{ d:'2026-03-17', c:'Flarc', b:15, r:0, a:112.50, s:'paid' },
		{ d:'2026-03-17', c:'Chef', b:3, r:7.5, a:22.50, s:'paid' },
		{ d:'2026-03-17', c:'Charlotte / Stzpr', b:250, r:0, a:4500, s:'paid', pr:8 },
		{ d:'2026-03-17', c:'Aboboyaa', b:110, r:0, a:660, s:'paid', pr:4 },
		// 18/03/26
		{ d:'2026-03-18', c:'Michael Defadu', b:80, r:7, a:560, s:'paid' },
		{ d:'2026-03-18', c:'Michael Defadu', b:50, r:7.5, a:365, s:'paid' },
		{ d:'2026-03-18', c:'Charlotte', b:500, r:6, a:2520, s:'paid', pr:20 },
		{ d:'2026-03-18', c:'Aboboyaa', b:110, r:6, a:660, s:'paid' },
		{ d:'2026-03-18', c:'Aboboyaa', b:110, r:6, a:660, s:'paid', pr:4 },
		{ d:'2026-03-18', c:'Ismael', b:25, r:7.5, a:187.50, s:'paid', p:'Momo + Cash' },
		// 19/03/26
		{ d:'2026-03-19', c:'Michael Dafadu', b:80, r:7, a:560, s:'paid' },
		{ d:'2026-03-19', c:'Charlotte', b:300, r:6, a:1800, s:'paid', pr:11 },
		{ d:'2026-03-19', c:'Aboboyaa', b:120, r:6, a:720, s:'paid', pr:4 },
		{ d:'2026-03-19', c:'Aboboyaa', b:110, r:6, a:660, s:'paid', pr:4 },
		{ d:'2026-03-19', c:'Individual', b:5, r:7, a:35, s:'paid' },
		// 20/03/26
		{ d:'2026-03-20', c:'Kia', b:50, r:6, a:300, s:'paid' },
		{ d:'2026-03-20', c:'Charlotte', b:500, r:6, a:3000, s:'paid' },
		{ d:'2026-03-20', c:'Michael Dze', b:50, r:7.5, a:375, s:'paid', p:'Cash + Momo' },
		{ d:'2026-03-20', c:'Carida', b:16, r:7.5, a:120, s:'paid' },
		// 21/03/26
		{ d:'2026-03-21', c:'Charlotte', b:500, r:6, a:3000, s:'paid', pr:208 },
		{ d:'2026-03-21', c:'Dafadu', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-21', c:'Dzepedu', b:4, r:7.5, a:30, s:'paid' },
		{ d:'2026-03-21', c:'Kukua', b:6, r:6, a:36, s:'paid' },
		{ d:'2026-03-21', c:'Christpha', b:2, r:6, a:12, s:'paid' },
		{ d:'2026-03-21', c:'Dzepedu', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-21', c:'Individual', b:110, r:6, a:660, s:'paid' },
		// 23/03/26
		{ d:'2026-03-23', c:'Charlotte', b:350, r:6, a:2100, s:'paid', pr:14 },
		{ d:'2026-03-23', c:'Charlotte', b:134, r:6, a:804, s:'paid', pr:10 },
		{ d:'2026-03-23', c:'Aboboyaa', b:40, r:6, a:240, s:'paid', pr:1 },
		{ d:'2026-03-23', c:'Apostle Dab', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-23', c:'Individual', b:5, r:7.5, a:37.50, s:'paid' },
		// 24/03/26
		{ d:'2026-03-24', c:'Charlotte', b:350, r:6, a:2100, s:'paid', pr:14 },
		{ d:'2026-03-24', c:'Charlotte', b:100, r:6, a:2400, s:'paid', pr:16 },
		{ d:'2026-03-24', c:'Boyit', b:7, r:6, a:42, s:'paid' },
		{ d:'2026-03-24', c:'Aboboyaa', b:110, r:6, a:660, s:'paid', p:'Momo', pr:6 },
		{ d:'2026-03-24', c:'Individual', b:20, r:7, a:140, s:'paid' },
		// 25/03/26
		{ d:'2026-03-25', c:'Charlotte', b:400, r:6, a:2400, s:'paid', pr:16 },
		{ d:'2026-03-25', c:'Dafadu', b:70, r:7.5, a:525, s:'paid' },
		{ d:'2026-03-25', c:'Dagadu', b:100, r:7.5, a:750, s:'paid', p:'Cash + Momo' },
		{ d:'2026-03-25', c:'Client (walk-in)', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-25', c:'Client', b:10, r:7.5, a:75, s:'paid' },
		{ d:'2026-03-25', c:'Walk-in', b:1, r:6, a:6, s:'paid' },
		{ d:'2026-03-25', c:'Charlotte', b:400, r:6, a:2400, s:'paid', pr:16 },
		{ d:'2026-03-25', c:'Dafadu', b:70, r:7.5, a:525, s:'paid' },
		{ d:'2026-03-25', c:'Dafadu', b:50, r:7.5, a:375, s:'paid' },
		// 26/03/26
		{ d:'2026-03-26', c:'Grace MTN (Eve)', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-26', c:'Charlotte', b:400, r:6, a:2400, s:'paid', pr:16 },
		{ d:'2026-03-26', c:'Walk-in', b:4, r:6, a:24, s:'paid' },
		{ d:'2026-03-26', c:'Walk-in', b:4, r:6, a:24, s:'paid' },
		{ d:'2026-03-26', c:'Madam Mamuko / Apmpzn Mofe Dztlts', b:100, r:7.5, a:750, s:'paid', p:'Momo', pr:4 },
		{ d:'2026-03-26', c:'Walk-in (Delney)', b:3, r:7.5, a:22.50, s:'paid', p:'Momo' },
		{ d:'2026-03-26', c:'Michael', b:50, r:7, a:250, s:'paid' },
		{ d:'2026-03-26', c:'Aboboyaa', b:100, r:6, a:600, s:'paid', pr:6 },
		{ d:'2026-03-26', c:'Walk-in', b:4, r:6, a:24, s:'paid' },
		// 27/03/26
		{ d:'2026-03-27', c:'Charlotte', b:450, r:6, a:2700, s:'paid' },
		{ d:'2026-03-27', c:'Walk-in', b:4, r:6, a:24, s:'paid', p:'Momo' },
		{ d:'2026-03-27', c:'Walk-in', b:7, r:6, a:42, s:'paid' },
		{ d:'2026-03-27', c:'Client', b:15, r:7.5, a:112.50, s:'paid' },
		{ d:'2026-03-27', c:'Laulas', b:8, r:6, a:0, s:'paid' },
		{ d:'2026-03-27', c:'Charlotte', b:350, r:6, a:2000, s:'paid' },
		{ d:'2026-03-27', c:'Aboboyaa', b:100, r:6, a:600, s:'paid' },
		// 28/03/26
		{ d:'2026-03-28', c:'Charlotte', b:450, r:6, a:2700, s:'paid', pr:16 },
		{ d:'2026-03-28', c:'Amos', b:100, r:7, a:700, s:'paid', pr:16 },
		{ d:'2026-03-28', c:'Aboboyaa', b:110, r:6, a:660, s:'paid', pr:6 },
		{ d:'2026-03-28', c:'Aboboyaa', b:100, r:6, a:600, s:'paid', pr:6 },
		{ d:'2026-03-28', c:'Walk-in', b:3, r:6, a:18, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in', b:10, r:6, a:60, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in', b:6, r:7, a:40, s:'paid' },
		{ d:'2026-03-28', c:'Carida Okadaahu', b:10, r:7.5, a:75, s:'paid' },
		{ d:'2026-03-28', c:'Charlotte', b:375, r:6, a:2250, s:'paid', pr:14 },
		{ d:'2026-03-28', c:'Aboboyaa', b:110, r:6, a:660, s:'paid' },
		{ d:'2026-03-28', c:'Aboboyaa', b:100, r:6, a:600, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in / Police', b:6, r:5, a:30, s:'paid' },
		{ d:'2026-03-28', c:'Daapaadu', b:47, r:7.5, a:352.50, s:'paid' },
		{ d:'2026-03-28', c:'Amos', b:7, r:7.5, a:42, s:'paid' },
		{ d:'2026-03-28', c:'Amos', b:44, r:7, a:208, s:'paid' },
		{ d:'2026-03-28', c:'Aboboyaa', b:100, r:6, a:600, s:'paid', pr:6 },
		{ d:'2026-03-28', c:'Walk-in', b:10, r:7.5, a:75, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in', b:6, r:6, a:36, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in', b:1, r:6, a:6, s:'paid' },
	];
	const product = '500ml Sachet Water (500 pcs/bag)';
	rows.forEach((r, i) => {
		const idx = String(i + 1).padStart(3, '0');
		const rate = r.r > 0 ? r.r : (r.b > 0 ? +(r.a / r.b).toFixed(2) : 0);
		const promo = r.pr !== undefined ? r.pr : (r.b > 100 ? Math.floor(r.b / 100) * 4 : 0);
		salesModuleData.invoices.push({
			id: `INV-2026-${idx}`, customer: r.c, product,
			date: r.d, paidDate: r.s === 'paid' ? r.d : '', status: r.s, amount: r.a, rate,
			paymentMode: r.p || '', promo,
			items: [{ name: product, qty: r.b, unitPrice: rate }],
			deliveryFee: 0,
		});
		salesModuleData.salesOrders.push({
			id: `SO-2026-${idx}`, customer: r.c,
			orderDate: r.d, deliveryDate: r.d,
			amount: r.a, bags: r.b, rate, paymentMode: r.p || '', promo,
			status: r.s === 'paid' ? 'delivered' : 'confirmed',
		});
	});
	saveSalesDataToStorage();
}

function saveSalesDataToStorage() {
	const month = currentSalesMonth;
	const key = monthStorageKey(month);
	const monthInvoices = (Array.isArray(salesModuleData.invoices) ? salesModuleData.invoices : [])
		.filter((inv) => isInvoiceInMonthBucket(inv, month));
	const activeInvoiceIds = new Set(monthInvoices.map((inv) => String(inv.id)).filter(Boolean));
	const monthOrders = (Array.isArray(salesModuleData.salesOrders) ? salesModuleData.salesOrders : [])
		.filter((ord) => {
			if (!ord || !ord.id) return false;
			if (ord.sourceInvoiceId) return activeInvoiceIds.has(String(ord.sourceInvoiceId));
			const ordMonth = getInvoiceMonth(ord);
			if (!shouldEnforceMonthDateFilter(month)) return true;
			return !ordMonth || ordMonth === month;
		});
	salesModuleData.invoices = monthInvoices;
	salesModuleData.salesOrders = monthOrders;
	let payload = buildSalesSyncPayload(month, salesModuleData);
	const cfg = getLockedSalesMonthConfig(month);
	if (cfg && !isLockedSalesPayload(month, payload)) {
		const locked = getLockedSalesPayload(month);
		if (locked) payload = locked;
	}
	payload.__wwLocalVersion = getNextSalesLocalVersion(month);
	updateLockedSalesPayloadIfCanonical(month, payload);
	localStorage.setItem(key, JSON.stringify(payload));
	setProtectedSalesPayload(month, payload);
	queuePendingSalesSync(month, payload);
	// Merge-push: fetch current server state first, union with local entries,
	// then push combined result so other devices' entries are never overwritten.
	const snapshot = { invoices: [...payload.invoices], salesOrders: [...payload.salesOrders], deletedInvoiceIds: [...(payload.deletedInvoiceIds || [])], deletedOrderIds: [...(payload.deletedOrderIds || [])] };
	mergeSyncSalesMonth(month, snapshot).then((ok) => {
		if (ok) clearPendingSalesSync(month);
	});
	// Notify other tabs instantly
	try {
		if (!window.__wwSalesChannel) window.__wwSalesChannel = new BroadcastChannel('ww_sales_sync');
		window.__wwSalesChannel.postMessage({ type: 'sales_updated', month });
	} catch (_e) { /* fallback to storage event */ }
}

function resequenceSalesIdsForCurrentMonth() {
	const year = String(currentSalesMonth || `${new Date().getFullYear()}-01`).slice(0, 4);
	const getIdNum = (id) => {
		const m = String(id || '').match(/(\d+)$/);
		return m ? Number(m[1]) : 0;
	};
	const byDateThenId = (a, b, dateFieldA, dateFieldB) => {
		const aDate = String(a?.[dateFieldA] || a?.date || '');
		const bDate = String(b?.[dateFieldB] || b?.date || '');
		const dateDiff = aDate.localeCompare(bDate);
		return dateDiff !== 0 ? dateDiff : getIdNum(a?.id) - getIdNum(b?.id);
	};

	const invoices = Array.isArray(salesModuleData.invoices) ? salesModuleData.invoices : [];
	const orders = Array.isArray(salesModuleData.salesOrders) ? salesModuleData.salesOrders : [];
	const orderedInvoices = [...invoices].sort((a, b) => byDateThenId(a, b, 'date', 'date'));
	const invoiceIdMap = new Map();

	orderedInvoices.forEach((inv, index) => {
		if (!inv) return;
		const oldId = String(inv.id || '');
		const newId = `INV-${year}-${String(index + 1).padStart(3, '0')}`;
		invoiceIdMap.set(oldId, newId);
		inv.id = newId;
	});

	const usedOrderNums = new Set();
	orders.forEach((ord) => {
		if (!ord) return;
		const mappedInvId = invoiceIdMap.get(String(ord.sourceInvoiceId || ''));
		if (!mappedInvId) return;
		ord.sourceInvoiceId = mappedInvId;
		const desiredNum = getIdNum(mappedInvId);
		if (!usedOrderNums.has(desiredNum) && desiredNum > 0) {
			ord.id = `SO-${year}-${String(desiredNum).padStart(3, '0')}`;
			usedOrderNums.add(desiredNum);
		}
	});

	let nextOrderNum = 1;
	const orderedOrders = [...orders].sort((a, b) => byDateThenId(a, b, 'orderDate', 'orderDate'));
	orderedOrders.forEach((ord) => {
		if (!ord) return;
		if (ord.sourceInvoiceId && /^SO-\d{4}(?:-\d{2})?-\d{3}$/.test(String(ord.id || '')) && usedOrderNums.has(getIdNum(ord.id))) return;
		while (usedOrderNums.has(nextOrderNum)) nextOrderNum += 1;
		ord.id = `SO-${year}-${String(nextOrderNum).padStart(3, '0')}`;
		usedOrderNums.add(nextOrderNum);
		nextOrderNum += 1;
	});
}

function nextInvoiceId() {
	// Numbering resets each month.
	const monthToken = /^\d{4}-\d{2}$/.test(String(currentSalesMonth || ''))
		? String(currentSalesMonth)
		: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
	const monthPattern = new RegExp(`^INV-${monthToken}-(\\d+)$`);
	const monthPayload = getSalesMonthPayload(monthToken);
	const deletedNums = new Set(
		normalizeIdArray(monthPayload && monthPayload.deletedInvoiceIds)
			.map((id) => {
				const m = String(id || '').match(monthPattern) || String(id || '').match(/(\d+)$/);
				return m ? Number(m[1]) : 0;
			})
			.filter((n) => Number.isFinite(n) && n > 0)
	);
	const used = new Set(
		salesModuleData.invoices
			.filter((inv) => {
				if (!inv || !inv.id) return false;
				if (monthPattern.test(String(inv.id))) return true;
				return getInvoiceMonth(inv) === monthToken;
			})
			.map((inv) => {
				const m = String(inv.id || '').match(monthPattern) || String(inv.id || '').match(/(\d+)$/);
				return m ? Number(m[1]) : 0;
			})
			.filter((n) => Number.isFinite(n) && n > 0)
	);
	for (const n of deletedNums) used.add(n);
	let next = 1;
	while (used.has(next)) next += 1;
	return `INV-${monthToken}-${String(next).padStart(3, '0')}`;
}

function nextOrderId() {
	// Numbering resets each month — choose the next missing number in this month
	const monthToken = /^\d{4}-\d{2}$/.test(String(currentSalesMonth || ''))
		? String(currentSalesMonth)
		: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
	const monthPattern = new RegExp(`^SO-${monthToken}-(\\d+)$`);
	const monthPayload = getSalesMonthPayload(monthToken);
	const deletedNums = new Set(
		normalizeIdArray(monthPayload && monthPayload.deletedOrderIds)
			.map((id) => {
				const m = String(id || '').match(monthPattern) || String(id || '').match(/(\d+)$/);
				return m ? Number(m[1]) : 0;
			})
			.filter((n) => Number.isFinite(n) && n > 0)
	);
	const used = new Set(
		salesModuleData.salesOrders
			.filter((ord) => {
				if (!ord || !ord.id) return false;
				if (monthPattern.test(String(ord.id))) return true;
				const ordMonth = getInvoiceMonth(ord);
				return !ordMonth || ordMonth === monthToken;
			})
			.map((o) => {
				const m = String(o.id || '').match(monthPattern) || String(o.id || '').match(/(\d+)$/);
				return m ? Number(m[1]) : 0;
			})
			.filter((n) => Number.isFinite(n) && n > 0)
	);
	for (const n of deletedNums) used.add(n);
	let next = 1;
	while (used.has(next)) next += 1;
	return `SO-${monthToken}-${String(next).padStart(3, '0')}`;
}

function upsertSalesOrderFromInvoice(invoice) {
	if (!invoice || !invoice.id) return;
	const derivedId = `SO${String(invoice.id).slice(3)}`;
	const targetIdx = salesModuleData.salesOrders.findIndex((o) => o.sourceInvoiceId === invoice.id || o.id === derivedId);
	const qty = invoice.items && invoice.items[0] ? Number(invoice.items[0].qty || 0) : 0;
	const rate = Number(invoice.rate || (invoice.items && invoice.items[0] ? invoice.items[0].unitPrice : 0) || 0);
	const orderData = {
		customer: invoice.customer,
		orderDate: invoice.date,
		deliveryDate: invoice.date,
		amount: Number(invoice.amount || 0),
		bags: qty,
		rate,
		paymentMode: invoice.paymentMode || '',
		carType: invoice.carType || '',
		promo: Number(invoice.promo || 0),
		promoNote: invoice.promoNote || '',
		status: invoice.status || 'pending',
		sourceInvoiceId: invoice.id,
		updatedAt: invoice.updatedAt || new Date().toISOString(),
	};
	if (targetIdx >= 0) {
		Object.assign(salesModuleData.salesOrders[targetIdx], orderData);
		return;
	}
	const idTaken = salesModuleData.salesOrders.some((o) => o.id === derivedId);
	salesModuleData.salesOrders.push({ id: idTaken ? nextOrderId() : derivedId, ...orderData });
}

function invoiceTotal(invoice) {
	if (!invoice.items || !invoice.items.length) return Number(invoice.amount || 0);
	return invoice.items.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
}

function renderInvoiceDetail(invoice) {
	const target = document.getElementById('invoice-detail-content');
	window.__wwSelectedInvoiceId = invoice && invoice.id ? String(invoice.id) : '';
	if (!target || !invoice) {
		return;
	}

	const hideMoney = window.__wwUserRole === 'supervisor' || window.__wwUserRole === 'staff';
	const items = invoice.items && invoice.items.length ? invoice.items : [{ name: invoice.product || 'Sale', qty: 1, unitPrice: Number(invoice.amount || 0) }];
	const subTotal = items.reduce((sum, it) => sum + (it.qty * it.unitPrice), 0);
	const deliveryFee = Number(invoice.deliveryFee || 0);
	const total = subTotal + deliveryFee;
	const invNo = getInvoiceDisplayId(invoice).replace(/^INV-\d{4}(?:-\d{2})?-/, 'WWW');
	const invIsApprover = canEditDelete(window.__wwUserRole || 'staff');
	const pendingBanner = invoice.status === 'pending_approval'
		? `<div class="approval-banner"><i class="fa-solid fa-hourglass-half"></i> Pending Approval${invIsApprover ? ' — <button class="btn-approve-inline inv-detail-approve-btn">Approve</button>' : ''}</div>`
		: '';

	function fmtDate(d) {
		if (!d) return '';
		const dt = new Date(d + 'T00:00:00');
		if (isNaN(dt)) return d;
		return dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
	}

	target.innerHTML = `
		${pendingBanner}
		<div class="inv-doc" id="inv-document">
			<div class="inv-doc-header">
				<div class="inv-doc-logo-area">
					<img src="../images/New%20Logo.jpeg" alt="Logo" class="inv-doc-logo">
				</div>
				<div class="inv-doc-company">
					<h2 class="inv-doc-company-name">White Water Wells LTD</h2>
					<p>Comm 25 Peace B Down, Accra-Prampram Road</p>
					<p>P.O. Box 18204, Accra</p>
					<p>GPS address: GN-0709-4736</p>
					<p>0243108878 / 0244483793</p>
				</div>
				<div class="inv-doc-title-area">
					<h3 class="inv-doc-title">INVOICE</h3>
				</div>
			</div>

			<div class="inv-doc-meta">
				<div class="inv-doc-bill-to">
					<p class="inv-doc-label">BILL TO:</p>
					<p class="inv-doc-val-big">${invoice.customer || ''}</p>
					<p class="inv-doc-val-sub">${invoice.address || ''}</p>
					<p class="inv-doc-val-sub">${invoice.phone ? 'Tel: ' + invoice.phone : ''}</p>
				</div>
				<div class="inv-doc-numbers">
					<div class="inv-doc-num-row"><span>Invoice no:</span><strong>${invNo}</strong></div>
					<div class="inv-doc-num-row"><span>Date:</span><strong>${fmtDate(invoice.date)}</strong></div>
					${invoice.entryTime ? `<div class="inv-doc-num-row"><span>Time:</span><strong>${invoice.entryTime}</strong></div>` : ''}
					${invoice.paidDate ? `<div class="inv-doc-num-row"><span>Paid date:</span><strong>${fmtDate(invoice.paidDate)}</strong></div>` : ''}
					${invoice.createdAt ? '<div class="inv-doc-num-row"><span>Created:</span><strong>' + new Date(invoice.createdAt).toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true }) + '</strong></div>' : ''}
				</div>
			</div>

			<table class="inv-doc-table">
				<thead><tr><th style="width:8%">S/N</th><th>PRODUCT DESCRIPTION</th><th style="width:10%">QTY</th><th style="width:18%">UNIT PRICE</th><th style="width:18%">TOTAL</th></tr></thead>
				<tbody>
					${items.map((it, i) => `<tr><td>${i + 1}</td><td>${it.name}</td><td>${it.qty}</td><td>${hideMoney ? '—' : 'GH₵' + Number(it.unitPrice).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td><td>${hideMoney ? '—' : 'GH₵' + (it.qty * it.unitPrice).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td></tr>`).join('')}
					${Array(Math.max(0, 5 - items.length)).fill('<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>').join('')}
				</tbody>
			</table>

			<div class="inv-doc-totals" ${hideMoney ? 'style="display:none"' : ''}>
				<div class="inv-doc-total-row"><span>SUB TOTAL</span><span>GH₵${subTotal.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span></div>
				${deliveryFee > 0 ? `<div class="inv-doc-total-row"><span>DELIVERY FEE</span><span>GH₵${deliveryFee.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span></div>` : ''}
				<div class="inv-doc-total-row"><span>TOTAL</span><span>GH₵${total.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span></div>
				<div class="inv-doc-total-row inv-doc-grand"><span>GRAND TOTAL</span><span>GH₵${total.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span></div>
			</div>

			<div class="inv-doc-terms">
				<p class="inv-doc-label">Terms &amp; Conditions</p>
				<p>No refunds allowed!</p>
			</div>

			<div class="inv-doc-signatures">
				<div class="inv-doc-sig"><span>Prepared by:</span><div class="inv-doc-sig-line"></div></div>
				<div class="inv-doc-sig"><span>Checked by:</span><div class="inv-doc-sig-line"></div></div>
				<div class="inv-doc-sig"><span>Received by:</span><div class="inv-doc-sig-line"></div></div>
			</div>

			<p class="inv-doc-tagline">Thank you for patronizing our Business!</p>
		</div>
		<div class="inv-doc-actions">
			<button type="button" class="btn-primary inv-doc-print-btn" id="inv-print-btn"><i class="fa-solid fa-print"></i> Print Invoice</button>
		</div>
	`;

	document.getElementById('inv-print-btn')?.addEventListener('click', () => {
		const doc = document.getElementById('inv-document');
		if (!doc) return;
		const invoiceCss = `
			* { margin:0; padding:0; box-sizing:border-box; }
			body { font-family: "Segoe UI", Arial, sans-serif; padding: 30px; color: #1e293b; font-size: 13px; }
			.inv-doc { max-width: 760px; margin: 0 auto; }
			.inv-doc-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 14px; }
			.inv-doc-logo { width: 72px; height: 72px; border-radius: 8px; object-fit: cover; }
			.inv-doc-company { flex: 1; }
			.inv-doc-company-name { font-size: 1.25rem; font-weight: 700; color: #1a3d5c; margin-bottom: 2px; }
			.inv-doc-company p { font-size: 0.82rem; line-height: 1.5; color: #334155; margin: 0; }
			.inv-doc-title-area { text-align: right; }
			.inv-doc-title { font-size: 1.5rem; color: #1a3d5c; letter-spacing: 2px; }
			.inv-doc-meta { display: flex; justify-content: space-between; margin: 16px 0; gap: 20px; }
			.inv-doc-bill-to { flex: 1; }
			.inv-doc-label { font-weight: 700; font-size: 0.85rem; color: #475569; margin-bottom: 4px; }
			.inv-doc-val-big { font-size: 1rem; font-weight: 600; }
			.inv-doc-val-sub { font-size: 0.85rem; color: #475569; }
			.inv-doc-numbers { text-align: right; }
			.inv-doc-num-row { margin-bottom: 4px; font-size: 0.88rem; }
			.inv-doc-num-row span { color: #64748b; margin-right: 8px; }
			.inv-doc-table { width: 100%; border-collapse: collapse; margin: 16px 0 8px; }
			.inv-doc-table th { background: #1a3d5c; color: #fff; padding: 8px 10px; text-align: left; font-size: 0.82rem; font-weight: 600; }
			.inv-doc-table td { border: 1px solid #cbd5e1; padding: 6px 10px; font-size: 0.85rem; }
			.inv-doc-totals { margin-left: auto; width: 280px; margin-top: 4px; }
			.inv-doc-total-row { display: flex; justify-content: space-between; padding: 5px 10px; font-size: 0.88rem; border-bottom: 1px solid #e2e8f0; }
			.inv-doc-grand { font-weight: 700; background: #f1f5f9; border-bottom: 2px solid #1a3d5c; }
			.inv-doc-terms { margin-top: 20px; }
			.inv-doc-terms p { font-size: 0.82rem; color: #475569; }
			.inv-doc-signatures { display: flex; gap: 24px; margin-top: 28px; }
			.inv-doc-sig { flex: 1; font-size: 0.85rem; font-weight: 600; }
			.inv-doc-sig-line { border-bottom: 1px solid #94a3b8; min-height: 30px; margin-top: 4px; }
			.inv-doc-tagline { text-align: center; font-style: italic; color: #2563eb; margin-top: 28px; font-size: 0.95rem; font-weight: 600; }
			.inv-doc-actions { display: none; }
			@media print { body { padding: 10px; } }
		`;
		const fullHtml = '<!DOCTYPE html><html><head><title>Invoice ' + invNo + '</title><style>' + invoiceCss + '</style></head><body>' + doc.outerHTML + '</body></html>';
		// Try popup print first; fall back to blob download
		try {
			const printWin = window.open('', '_blank', 'width=800,height=1100');
			if (printWin && printWin.document) {
				printWin.document.write(fullHtml);
				printWin.document.close();
				setTimeout(() => { printWin.focus(); printWin.print(); }, 300);
				return;
			}
		} catch (_e) { /* popup blocked */ }
		// Blob fallback
		const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'invoice-' + invNo + '.html';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	});
	// Dummy reference to satisfy old code path — actual styles now inlined above
	const _unusedPrintRef = '<!DOCTYPE html><html><head><title>Invoice ' + invNo + '</title><style>' +
			'* { margin:0; padding:0; box-sizing:border-box; }' +
			'body { font-family: "Segoe UI", Arial, sans-serif; padding: 30px; color: #1e293b; font-size: 13px; }' +
			'.inv-doc { max-width: 760px; margin: 0 auto; }' +
			'.inv-doc-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 14px; }' +
			'.inv-doc-logo { width: 72px; height: 72px; border-radius: 8px; object-fit: cover; }' +
			'.inv-doc-company { flex: 1; }' +
			'.inv-doc-company-name { font-size: 1.25rem; font-weight: 700; color: #1a3d5c; margin-bottom: 2px; }' +
			'.inv-doc-company p { font-size: 0.82rem; line-height: 1.5; color: #334155; margin: 0; }' +
			'.inv-doc-title-area { text-align: right; }' +
			'.inv-doc-title { font-size: 1.5rem; color: #1a3d5c; letter-spacing: 2px; }' +
			'.inv-doc-meta { display: flex; justify-content: space-between; margin: 16px 0; gap: 20px; }' +
			'.inv-doc-bill-to { flex: 1; }' +
			'.inv-doc-label { font-weight: 700; font-size: 0.85rem; color: #475569; margin-bottom: 4px; }' +
			'.inv-doc-val-big { font-size: 1rem; font-weight: 600; }' +
			'.inv-doc-val-sub { font-size: 0.85rem; color: #475569; }' +
			'.inv-doc-numbers { text-align: right; }' +
			'.inv-doc-num-row { margin-bottom: 4px; font-size: 0.88rem; }' +
			'.inv-doc-num-row span { color: #64748b; margin-right: 8px; }' +
			'.inv-doc-table { width: 100%; border-collapse: collapse; margin: 16px 0 8px; }' +
			'.inv-doc-table th { background: #1a3d5c; color: #fff; padding: 8px 10px; text-align: left; font-size: 0.82rem; font-weight: 600; }' +
			'.inv-doc-table td { border: 1px solid #cbd5e1; padding: 6px 10px; font-size: 0.85rem; }' +
			'.inv-doc-totals { margin-left: auto; width: 280px; margin-top: 4px; }' +
	target.querySelector('.inv-detail-approve-btn')?.addEventListener('click', () => {
		const idx = salesModuleData.invoices.findIndex((inv) => inv.id === invoice.id);
		if (idx >= 0) {
			salesModuleData.invoices[idx].status = salesModuleData.invoices[idx].requestedStatus || 'pending';
			salesModuleData.invoices[idx].updatedAt = new Date().toISOString();
			delete salesModuleData.invoices[idx].requestedStatus;
			saveSalesDataToStorage();
			renderInvoiceDetail(salesModuleData.invoices[idx]);
			/* refresh table if renderSalesPage exists in scope — trigger via custom event */
			document.dispatchEvent(new Event('ww-refresh-sales'));
		}
	});
}

async function initSalesInvoicesPage() {
  try {
	const page = document.body.getAttribute('data-page');
	if (page !== 'invoices' && page !== 'sales') {
		return;
	}
	await clearSalesBrowserCacheIfServerEmpty();
	await reloadSalesMonthsFromServerHard();

	const userRole = await resolveCurrentUserRole();
	const isApprover = canEditDelete(userRole);

	loadSalesDataFromStorage();
	console.log('[Sales] Loaded month:', currentSalesMonth, '| Invoices:', salesModuleData.invoices.length, '| Orders:', salesModuleData.salesOrders.length);

	const refreshSalesMonthFromServer = async (targetMonth) => {
		try {
			const month = String(targetMonth || currentSalesMonth || '');
			if (!/^\d{4}-\d{2}$/.test(month)) return false;
			const syncKey = monthStorageKey(month);
			if (hasPendingSalesSyncForKey(syncKey)) {
				const pendingPayload = getPendingSalesSyncPayload(month);
				const snapshot = pendingPayload && typeof pendingPayload === 'object'
					? pendingPayload
					: {
						invoices: [...salesModuleData.invoices],
						salesOrders: [...salesModuleData.salesOrders],
					};
				const flushed = await mergeSyncSalesMonth(month, snapshot);
				if (flushed) clearPendingSalesSync(month);
			}
			const serverData = await loadFromServerForceFresh(syncKey);
			if (month !== currentSalesMonth) return false;
			const changed = mergeServerSalesIntoMemory(serverData, month);
			if (!changed) return false;
			const updatedPayload = buildSalesSyncPayload(month, salesModuleData);
			localStorage.setItem(syncKey, JSON.stringify(updatedPayload));
			if (month !== currentSalesMonth) return false;
			loadMonthData(month);
			renderSalesPage();
			return true;
		} catch (_e) {
			return false;
		}
	};

	/* ── Cross-tab live sync ── */
	if (!window.__wwSalesSyncBound) {
		window.__wwSalesSyncBound = true;
		// BroadcastChannel (instant, same origin)
		try {
			if (!window.__wwSalesChannel) window.__wwSalesChannel = new BroadcastChannel('ww_sales_sync');
			window.__wwSalesChannel.onmessage = (e) => {
				if (e.data && e.data.type === 'sales_updated') {
					loadMonthData(currentSalesMonth);
					renderSalesPage();
				}
			};
		} catch (_e) { /* ignore */ }
		// Fallback: storage event (fires when another tab writes localStorage)
		window.addEventListener('storage', (event) => {
			if (event.key && event.key.startsWith('ww_sales_')) {
				loadMonthData(currentSalesMonth);
				renderSalesPage();
			}
		});
	}

	/* ── Month selector setup ── */
	const monthSelect = document.getElementById('sales-month-select');
	const yearSelect = document.getElementById('sales-year-select');
	const yearLabel = document.getElementById('sales-year-label');
	const newMonthBtn = document.getElementById('new-month-btn');
	const repairMonthBtn = document.getElementById('repair-month-btn');
	let selectedSalesYear = null;

	function populateMonthSelect(options) {
		const opts = options || {};
		if (!monthSelect) return;
		const allMonths = getSalesMonths();
		const years = [...new Set(allMonths.map((m) => Number(String(m).slice(0, 4))).filter(Number.isFinite))].sort((a, b) => a - b);
		const hasMultiYear = years.length > 1;
		if (yearSelect && yearLabel) {
			yearSelect.style.display = hasMultiYear ? '' : 'none';
			yearLabel.style.display = hasMultiYear ? '' : 'none';
			if (hasMultiYear) {
				if (!selectedSalesYear || !years.includes(selectedSalesYear)) {
					selectedSalesYear = Number(String(currentSalesMonth || allMonths[allMonths.length - 1] || '').slice(0, 4)) || years[years.length - 1];
				}
				yearSelect.innerHTML = [...years].sort((a, b) => b - a).map((y) => `<option value="${y}">${y}</option>`).join('');
				yearSelect.value = String(selectedSalesYear);
			} else {
				selectedSalesYear = years[0] || null;
			}
		}
		const months = hasMultiYear
			? allMonths.filter((m) => Number(String(m).slice(0, 4)) === selectedSalesYear)
			: allMonths;
		monthSelect.innerHTML = months.map((m) =>
			`<option value="${m}" ${m === currentSalesMonth ? 'selected' : ''}>${monthLabel(m)}</option>`
		).join('');
		if (!months.includes(currentSalesMonth) && months.length) {
			currentSalesMonth = months[months.length - 1];
			if (!opts.skipLoad) loadMonthData(currentSalesMonth);
		}
	}
	populateMonthSelect();

	if (monthSelect) {
		monthSelect.addEventListener('change', () => {
			selectedSalesYear = Number(String(monthSelect.value || '').slice(0, 4)) || selectedSalesYear;
			loadMonthData(monthSelect.value);
			populateMonthSelect({ skipLoad: true });
			renderSalesPage();
			refreshSalesMonthFromServer(currentSalesMonth);
		});
	}

	if (yearSelect) {
		yearSelect.addEventListener('change', () => {
			const nextYear = Number(yearSelect.value);
			if (!Number.isFinite(nextYear)) return;
			selectedSalesYear = nextYear;
			const monthsForYear = getSalesMonths().filter((m) => Number(String(m).slice(0, 4)) === selectedSalesYear);
			if (!monthsForYear.length) return;
			loadMonthData(monthsForYear[monthsForYear.length - 1]);
			populateMonthSelect({ skipLoad: true });
			renderSalesPage();
			refreshSalesMonthFromServer(currentSalesMonth);
		});
	}

	if (newMonthBtn) {
		newMonthBtn.addEventListener('click', () => {
			const input = prompt('Enter month (YYYY-MM):', (() => {
				const d = new Date();
				return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
			})());
			if (!input || !/^\d{4}-\d{2}$/.test(input.trim())) return;
			const month = input.trim();
			const months = getSalesMonths();
			selectedSalesYear = Number(month.slice(0, 4)) || selectedSalesYear;
			if (months.includes(month)) {
				loadMonthData(month);
			} else {
				ensureMonthExists(month);
				loadMonthData(month);
				saveSalesDataToStorage();
			}
			populateMonthSelect();
			renderSalesPage();
			refreshSalesMonthFromServer(currentSalesMonth);
		});
	}

	if (repairMonthBtn) {
		repairMonthBtn.addEventListener('click', () => {
			const month = currentSalesMonth;
			if (!month) return;
			const ok = window.confirm(`Repair ${monthLabel(month)} consistency now? This keeps your latest entries and rebuilds invoice/sales pairing.`);
			if (!ok) return;
			const summary = repairSalesMonthConsistency(month);
			loadMonthData(month);
			renderSalesPage();
			alert(
				`Repair complete for ${monthLabel(month)}.\n` +
				`Invoices: ${summary.beforeInvoices} -> ${summary.afterInvoices}\n` +
				`Sales Orders: ${summary.beforeOrders} -> ${summary.afterOrders}`
			);
		});
	}

	const todayStr = getTodayDateStr();
	const SI_MODAL_CONFIGS = {
		invoice: {
			title: 'Add Invoice',
			fields: [
				{ id: 'carType', label: 'Car Type', type: 'text', placeholder: 'e.g. Lexus' },
				{ id: 'carNumber', label: 'Car Number', type: 'text', placeholder: 'e.g. GR-1234-20' },
				{ id: 'entryTime', label: 'Entry Time', type: 'time' },
				{ id: 'customer', label: 'Customer Name', type: 'text', required: true },
				{ id: 'address', label: 'Address / P.O. Box', type: 'text', placeholder: 'City / Street / P.O. Box' },
				{ id: 'phone', label: 'Telephone', type: 'text', placeholder: '000-000-0000' },
				{ id: 'product', label: 'Product', type: 'select', required: true, options: getAvailableInvoiceProducts() },
				{ id: 'qty', label: 'Quantity', type: 'number', min: '1', required: true },
				{ id: 'promo', label: 'Promo', type: 'number', min: '0', defaultValue: '0' },
				{ id: 'unitPrice', label: 'Unit Price (GH)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'date', label: 'Invoice Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'status', label: 'Status', type: 'select', options: ['overdue', 'paid', 'pending'], defaultValue: 'paid' },
				{ id: 'paymentMode', label: 'Payment Mode', type: 'select', options: ['', 'Cash', 'Momo', 'Cash + Momo'] },
			],
		},
		order: {
			title: 'Add Sales Order',
			fields: [
				{ id: 'carType', label: 'Car Type', type: 'text', placeholder: 'e.g. Lexus' },
				{ id: 'carNumber', label: 'Car Number', type: 'text', placeholder: 'e.g. GR-1234-20' },
				{ id: 'customer', label: 'Customer Name', type: 'text', required: true },
				{ id: 'orderDate', label: 'Order Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'unitPrice', label: 'Unit Price (GH)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'amount', label: 'Amount (GH)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'promo', label: 'Promo', type: 'number', min: '0', defaultValue: '0' },
				{ id: 'paymentMode', label: 'Payment Mode', type: 'select', options: ['', 'Cash', 'Momo', 'Cash + Momo'] },
			],
		},
	};

	const addModal = document.getElementById('si-add-modal');
	const modalTitle = document.getElementById('si-modal-title');
	const modalFieldsEl = document.getElementById('si-modal-fields');
	const modalForm = document.getElementById('si-add-form');
	let currentEntity = null;
	let editingSiIdx = -1;
	let currentSubmitTxnId = '';
	let siSubmitInFlight = false;
	const siDraftStorageKey = (entity) => `ww_sales_modal_draft_${currentSalesMonth}_${entity}`;
	const generateClientTxnId = (entity) => `${entity}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

	const clearModalValidation = () => {
		if (!modalFieldsEl) return;
		modalFieldsEl.querySelectorAll('.inv-modal-field').forEach((field) => field.classList.remove('has-error'));
		modalFieldsEl.querySelectorAll('.inv-modal-error').forEach((msg) => { msg.textContent = ''; });
		const summary = modalFieldsEl.querySelector('#si-modal-error-summary');
		if (summary) summary.textContent = '';
	};

	const setFieldValidationError = (fieldId, message) => {
		const input = document.getElementById(`si-field-${fieldId}`);
		if (!input) return;
		const fieldWrap = input.closest('.inv-modal-field');
		if (fieldWrap) fieldWrap.classList.add('has-error');
		const msgEl = document.getElementById(`si-err-${fieldId}`);
		if (msgEl) msgEl.textContent = message;
	};

	const validateModalRequiredFields = (options) => {
		const opts = options || {};
		const focusFirst = opts.focusFirst !== false;
		const showSummary = opts.showSummary !== false;
		const config = SI_MODAL_CONFIGS[currentEntity];
		if (!config) return true;
		clearModalValidation();
		const missing = [];
		for (const field of config.fields) {
			if (!field.required) continue;
			const value = getValue(field.id);
			if (value) continue;
			missing.push(field);
			setFieldValidationError(field.id, `${field.label} is required.`);
		}
		if (!missing.length) return true;
		const summary = modalFieldsEl ? modalFieldsEl.querySelector('#si-modal-error-summary') : null;
		if (summary && showSummary) {
			summary.textContent = 'Please fill the highlighted required fields.';
		}
		if (focusFirst) {
			const firstMissing = document.getElementById(`si-field-${missing[0].id}`);
			if (firstMissing) firstMissing.focus();
		}
		return false;
	};

	const saveModalDraft = (entity) => {
		if (!entity || editingSiIdx >= 0) return;
		const config = SI_MODAL_CONFIGS[entity];
		if (!config) return;
		const values = {};
		config.fields.forEach((field) => {
			const el = document.getElementById(`si-field-${field.id}`);
			if (!el) return;
			values[field.id] = el.value;
		});
		try {
			if (currentSubmitTxnId) values.__txnId = currentSubmitTxnId;
			localStorage.setItem(siDraftStorageKey(entity), JSON.stringify({ values, ts: Date.now() }));
		} catch (_e) { /* ignore */ }
	};

	const clearModalDraft = (entity) => {
		if (!entity) return;
		try {
			localStorage.removeItem(siDraftStorageKey(entity));
		} catch (_e) { /* ignore */ }
	};

	const restoreModalDraft = (entity) => {
		if (!entity || editingSiIdx >= 0) return;
		try {
			const raw = localStorage.getItem(siDraftStorageKey(entity));
			if (!raw) return;
			const parsed = JSON.parse(raw);
			const values = parsed && parsed.values ? parsed.values : null;
			if (!values || typeof values !== 'object') return;
			Object.keys(values).forEach((fieldId) => {
				const el = document.getElementById(`si-field-${fieldId}`);
				if (!el) return;
				if (!String(el.value || '').trim() && values[fieldId] !== undefined && values[fieldId] !== null) {
					el.value = String(values[fieldId]);
				}
			});
		} catch (_e) { /* ignore */ }
	};

	const getModalDraft = (entity) => {
		if (!entity) return null;
		try {
			const raw = localStorage.getItem(siDraftStorageKey(entity));
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			const values = parsed && parsed.values ? parsed.values : null;
			if (!values || typeof values !== 'object') return null;
			const hasAnyValue = Object.values(values).some((v) => String(v || '').trim() !== '');
			return hasAnyValue ? values : null;
		} catch (_e) {
			return null;
		}
	};

	const bindModalLiveHandlers = () => {
		if (!modalFieldsEl) return;
		const controls = modalFieldsEl.querySelectorAll('input, select, textarea');
		controls.forEach((ctrl) => {
			const syncState = () => {
				saveModalDraft(currentEntity);
				validateModalRequiredFields({ focusFirst: false, showSummary: false });
			};
			ctrl.addEventListener('input', syncState);
			ctrl.addEventListener('change', syncState);
			ctrl.addEventListener('blur', () => {
				validateModalRequiredFields({ focusFirst: false, showSummary: false });
			});
		});
	};

	const closeModal = (skipDraft = false) => {
		const savedEntity = currentEntity;
		const wasAdding = editingSiIdx < 0;
		if (!skipDraft && wasAdding && savedEntity) saveModalDraft(savedEntity);
		// Clear state before form reset so any reset-triggered handlers cannot re-save draft.
		currentEntity = null;
		editingSiIdx = -1;
		if (addModal) addModal.style.display = 'none';
		if (modalForm) modalForm.reset();
		clearModalValidation();
		currentSubmitTxnId = '';
		siSubmitInFlight = false;
		if (!skipDraft && wasAdding && savedEntity) renderSalesPage();
	};

	window.addEventListener('beforeunload', () => { if (editingSiIdx < 0 && currentEntity) saveModalDraft(currentEntity); });

	const openModal = (entity, editId, resumeDraft = false) => {
		let config = SI_MODAL_CONFIGS[entity];
		if (!config || !addModal) return;
		if (entity === 'invoice') {
			const editingInvoice = editId != null
				? salesModuleData.invoices.find((inv) => String(inv.id) === String(editId))
				: null;
			config = {
				...config,
				fields: config.fields.map((field) => (
					field.id === 'product'
						? { ...field, options: getAvailableInvoiceProducts(editingInvoice?.product || editingInvoice?.items?.[0]?.name) }
						: field
				)),
			};
		}
		currentEntity = entity;
		// Resolve editing index from ID so we always get the right record regardless of array order
		if (editId != null) {
			if (entity === 'invoice') {
				editingSiIdx = salesModuleData.invoices.findIndex((inv) => String(inv.id) === String(editId));
			} else if (entity === 'order') {
				editingSiIdx = salesModuleData.salesOrders.findIndex((ord) => String(ord.id) === String(editId));
			} else {
				editingSiIdx = -1;
			}
		} else {
			editingSiIdx = -1;
		}
		if (editingSiIdx >= 0) {
			currentSubmitTxnId = '';
		} else {
			const draft = getModalDraft(entity);
			const draftTxn = draft && typeof draft.__txnId === 'string' ? draft.__txnId.trim() : '';
			currentSubmitTxnId = draftTxn || generateClientTxnId(entity);
		}
		if (modalTitle) modalTitle.textContent = editingSiIdx >= 0 ? config.title.replace('Add', 'Edit') : config.title;
		if (modalFieldsEl) {
			modalFieldsEl.innerHTML = `<p class="inv-modal-summary-error" id="si-modal-error-summary" aria-live="polite"></p>` + config.fields.map((f) => {
				if (f.type === 'select') {
					return `
						<div class="inv-modal-field">
							<label for="si-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label>
							<select id="si-field-${f.id}" name="${f.id}" ${f.required ? 'required' : ''}>
								${f.options.map((o) => `<option value="${o}"${f.defaultValue !== undefined && String(f.defaultValue) === String(o) ? ' selected' : ''}>${o ? (o.charAt(0).toUpperCase() + o.slice(1)) : ''}</option>`).join('')}
							</select>
							<p class="inv-modal-error" id="si-err-${f.id}" aria-live="polite"></p>
						</div>
					`;
				}
				return `
					<div class="inv-modal-field">
						<label for="si-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label>
						<input
							id="si-field-${f.id}"
							type="${f.type}"
							name="${f.id}"
							${f.required ? 'required' : ''}
							${f.min !== undefined ? `min="${f.min}"` : ''}
							${f.step ? `step="${f.step}"` : ''}
							${f.placeholder ? `placeholder="${f.placeholder}"` : ''}
							${f.defaultValue ? `value="${f.defaultValue}"` : ''}
						>
						<p class="inv-modal-error" id="si-err-${f.id}" aria-live="polite"></p>
					</div>
				`;
			}).join('');
		}
		/* Pre-fill for editing */
		if (editingSiIdx >= 0) {
			let row;
			if (entity === 'invoice') {
				row = salesModuleData.invoices[editingSiIdx];
				if (row) {
					const setVal = (id, v) => { const el = document.getElementById('si-field-' + id); if (el && v !== undefined) el.value = v; };
					setVal('customer', row.customer);
					setVal('address', row.address);
					setVal('phone', row.phone);
					setVal('product', row.product || (row.items && row.items[0] ? row.items[0].name : ''));
					setVal('qty', row.items && row.items[0] ? row.items[0].qty : 1);
					setVal('unitPrice', row.items && row.items[0] ? row.items[0].unitPrice : row.amount);
					setVal('promo', row.promo || 0);
					setVal('date', row.date);
					setVal('status', row.status || 'paid');
					setVal('paymentMode', row.paymentMode);
					setVal('carType', row.carType || '');
					setVal('carNumber', row.carNumber || '');
					setVal('entryTime', row.entryTime || '');
				}
			} else if (entity === 'order') {
				row = salesModuleData.salesOrders[editingSiIdx];
				if (row) {
					const setVal = (id, v) => { const el = document.getElementById('si-field-' + id); if (el && v !== undefined) el.value = v; };
					setVal('customer', row.customer);
					setVal('orderDate', row.orderDate);
					setVal('unitPrice', row.rate || (row.bags && row.amount ? +(row.amount / row.bags).toFixed(2) : ''));
					setVal('amount', row.amount);
					setVal('promo', row.promo || 0);
					setVal('paymentMode', row.paymentMode);
					setVal('carType', row.carType || '');
					setVal('carNumber', row.carNumber || '');
				}
			}
		}
		if (resumeDraft) restoreModalDraft(entity);
		if (editingSiIdx < 0 && entity === 'invoice') {
			const productField = document.getElementById('si-field-product');
			if (productField && !String(productField.value || '').trim() && productField.options && productField.options.length) {
				productField.value = productField.options[0].value;
			}
		}
		addModal.style.display = 'flex';
		/* Auto-calculate promo when qty changes: 4 bags per 100 */
		const qtyField = document.getElementById('si-field-qty');
		const promoField = document.getElementById('si-field-promo');
		if (qtyField && promoField) {
			qtyField.addEventListener('input', () => {
				const qty = parseInt(qtyField.value) || 0;
				promoField.value = qty > 100 ? Math.floor(qty / 100) * 4 : 0;
			});
		}
		const firstInput = modalFieldsEl && modalFieldsEl.querySelector('input, select');
		if (firstInput) firstInput.focus();
		clearModalValidation();
		bindModalLiveHandlers();
		validateModalRequiredFields({ focusFirst: false, showSummary: false });
	};

	document.getElementById('si-modal-close')?.addEventListener('click', closeModal);
	document.getElementById('si-modal-cancel')?.addEventListener('click', closeModal);
	addModal?.addEventListener('click', (e) => { if (e.target === addModal) closeModal(); });

	const getValue = (id) => {
		const el = document.getElementById(`si-field-${id}`);
		return el ? el.value.trim() : '';
	};
	const getNum = (id) => {
		const v = Number(getValue(id));
		return Number.isFinite(v) && v >= 0 ? v : 0;
	};

	const validateEntryMonth = (fieldId, isoDate) => {
		const value = String(isoDate || '').trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			setFieldValidationError(fieldId, 'Please provide a valid date.');
			const summary = modalFieldsEl ? modalFieldsEl.querySelector('#si-modal-error-summary') : null;
			if (summary) summary.textContent = 'Please fix the highlighted date field.';
			return false;
		}
		const selectedMonth = String(currentSalesMonth || '').trim();
		if (!/^\d{4}-\d{2}$/.test(selectedMonth)) return true;
		if (value.slice(0, 7) === selectedMonth) return true;
		setFieldValidationError(fieldId, `Date must be within ${monthLabel(selectedMonth)}.`);
		const summary = modalFieldsEl ? modalFieldsEl.querySelector('#si-modal-error-summary') : null;
		if (summary) summary.textContent = `Entries in this view must use a ${monthLabel(selectedMonth)} date.`;
		const dateField = document.getElementById(`si-field-${fieldId}`);
		if (dateField) dateField.focus();
		return false;
	};

	if (modalForm && !modalForm.dataset.bound) {
		modalForm.dataset.bound = '1';
		modalForm.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!currentEntity) return;
			if (siSubmitInFlight) return;
			if (!validateModalRequiredFields()) return;
			siSubmitInFlight = true;
			const finalizeSubmit = () => { siSubmitInFlight = false; };
			const submitTxnId = editingSiIdx >= 0 ? '' : (currentSubmitTxnId || generateClientTxnId(currentEntity));
			if (editingSiIdx < 0) currentSubmitTxnId = submitTxnId;

			try {

			if (currentEntity === 'invoice') {
				const customer = getValue('customer');
				const product = getValue('product');
				if (!customer || !product) return;
				const invDate = getValue('date') || todayStr;
				if (!validateEntryMonth('date', invDate)) return;
				const existingInvoice = editingSiIdx >= 0 ? salesModuleData.invoices[editingSiIdx] : null;
				const chosenStatus = getValue('status') || existingInvoice?.requestedStatus || existingInvoice?.status || 'paid';
				const invData = {
					customer,
					address: getValue('address'),
					phone: getValue('phone'),
					date: invDate,
					paidDate: chosenStatus === 'paid' ? invDate : '',
					status: chosenStatus,
					requestedStatus: undefined,
					paymentMode: getValue('paymentMode'),
					carType: getValue('carType'),
					carNumber: getValue('carNumber'),
					entryTime: getValue('entryTime'),
					promo: getNum('promo'),
					promoNote: existingInvoice?.promoNote || '',
					product,
					items: [{ name: product, qty: getNum('qty') || 1, unitPrice: getNum('unitPrice') }],
					deliveryFee: 0,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					...(submitTxnId ? { clientTxnId: submitTxnId, idempotencyKey: submitTxnId } : {}),
				};
				invData.rate = invData.items[0].unitPrice;
				invData.amount = invData.items[0].qty * invData.items[0].unitPrice;
				if (String(invData.status || '').toLowerCase() === 'paid' && Number(invData.amount || 0) <= 0) {
					setFieldValidationError('unitPrice', 'Paid invoices must have an amount greater than 0.');
					const summary = modalFieldsEl ? modalFieldsEl.querySelector('#si-modal-error-summary') : null;
					if (summary) summary.textContent = 'Paid invoices cannot be saved with a zero amount.';
					const unitPriceInput = document.getElementById('si-field-unitPrice');
					if (unitPriceInput) unitPriceInput.focus();
					return;
				}
				let savedInvoice;
				if (editingSiIdx >= 0 && salesModuleData.invoices[editingSiIdx]) {
					Object.assign(salesModuleData.invoices[editingSiIdx], invData);
					savedInvoice = salesModuleData.invoices[editingSiIdx];
				} else {
					const existingByTxn = submitTxnId
						? salesModuleData.invoices.find((inv) => String(inv?.clientTxnId || '') === String(submitTxnId))
						: null;
					if (existingByTxn) {
						savedInvoice = existingByTxn;
					} else {
						invData.id = nextInvoiceId();
						unmarkSalesDeletion(currentSalesMonth, 'invoice', invData.id);
						unmarkSalesDeletion(currentSalesMonth, 'order', `SO${String(invData.id).slice(3)}`);
						if (!invData.createdAt) invData.createdAt = new Date().toISOString();
						salesModuleData.invoices.push(invData);
						savedInvoice = invData;
					}
				}
				upsertSalesOrderFromInvoice(savedInvoice);
			}

			if (currentEntity === 'order') {
				const customer = getValue('customer');
				if (!customer) return;
				const orderDate = getValue('orderDate') || todayStr;
				if (!validateEntryMonth('orderDate', orderDate)) return;
				const existingOrder = editingSiIdx >= 0 ? salesModuleData.salesOrders[editingSiIdx] : null;
				const chosenStatus = existingOrder?.requestedStatus || existingOrder?.status || 'delivered';
				const ordData = {
					customer,
					orderDate,
					deliveryDate: existingOrder?.deliveryDate || orderDate,
					rate: getNum('unitPrice'),
					amount: getNum('amount'),
					promo: getNum('promo'),
					promoNote: existingOrder?.promoNote || '',
					paymentMode: getValue('paymentMode'),
					carType: getValue('carType'),
					carNumber: getValue('carNumber'),
					status: chosenStatus,
					requestedStatus: undefined,
					updatedAt: new Date().toISOString(),
					...(submitTxnId ? { clientTxnId: submitTxnId, idempotencyKey: submitTxnId } : {}),
				};
				if (editingSiIdx >= 0 && salesModuleData.salesOrders[editingSiIdx]) {
					Object.assign(salesModuleData.salesOrders[editingSiIdx], ordData);
					const linkedOrder = salesModuleData.salesOrders[editingSiIdx];
					const derivedInvoiceId = linkedOrder && linkedOrder.id ? `INV${String(linkedOrder.id).slice(2)}` : '';
					const linkedInvoice = salesModuleData.invoices.find((inv) => String(inv.id) === String(linkedOrder?.sourceInvoiceId || ''))
						|| salesModuleData.invoices.find((inv) => String(inv.id) === String(derivedInvoiceId));
					if (linkedInvoice) {
						const firstItem = Array.isArray(linkedInvoice.items) && linkedInvoice.items[0] ? linkedInvoice.items[0] : null;
						const qty = Number((linkedOrder?.bags || (firstItem && firstItem.qty) || 1) || 1);
						const unitPrice = qty > 0 ? +(ordData.amount / qty).toFixed(2) : ordData.rate;
						linkedInvoice.customer = ordData.customer;
						linkedInvoice.date = ordData.orderDate;
						linkedInvoice.paidDate = String(ordData.status || '').toLowerCase() === 'paid' ? ordData.orderDate : (linkedInvoice.paidDate || '');
						linkedInvoice.paymentMode = ordData.paymentMode;
						linkedInvoice.carType = ordData.carType;
						linkedInvoice.carNumber = ordData.carNumber;
						linkedInvoice.promo = Number(ordData.promo || 0);
						linkedInvoice.rate = unitPrice;
						linkedInvoice.amount = Number(ordData.amount || 0);
						linkedInvoice.items = [{
							name: (firstItem && firstItem.name) || linkedInvoice.product || 'Mobile water (500ML)',
							qty,
							unitPrice,
						}];
						linkedInvoice.updatedAt = ordData.updatedAt;
					}
				} else {
					const existingOrderByTxn = submitTxnId
						? salesModuleData.salesOrders.find((ord) => String(ord?.clientTxnId || '') === String(submitTxnId))
						: null;
					if (existingOrderByTxn) {
						saveSalesDataToStorage();
						const savedEntity = currentEntity;
						clearModalDraft(savedEntity);
						closeModal(true); // skip draft re-save — we just submitted successfully
						clearModalDraft(savedEntity);
						renderSalesPage();
						return;
					}
					const invId = nextInvoiceId();
					const qty = Number(existingOrder?.bags || 1) || 1;
					const unitPrice = qty > 0 ? +(ordData.amount / qty).toFixed(2) : ordData.rate;
					const invData = {
						id: invId,
						customer,
						date: orderDate,
						paidDate: String(chosenStatus || '').toLowerCase() === 'paid' ? orderDate : '',
						status: chosenStatus,
						paymentMode: ordData.paymentMode,
						carType: ordData.carType,
						carNumber: ordData.carNumber,
						promo: Number(ordData.promo || 0),
						promoNote: ordData.promoNote || '',
						product: 'Mobile water (500ML)',
						items: [{ name: 'Mobile water (500ML)', qty, unitPrice }],
						deliveryFee: 0,
						rate: unitPrice,
						amount: Number(ordData.amount || 0),
						createdAt: new Date().toISOString(),
						updatedAt: ordData.updatedAt,
						...(submitTxnId ? { clientTxnId: submitTxnId, idempotencyKey: submitTxnId } : {}),
					};
					ordData.id = `SO${String(invId).slice(3)}`;
					ordData.sourceInvoiceId = invId;
					ordData.bags = qty;
					unmarkSalesDeletion(currentSalesMonth, 'invoice', invId);
					unmarkSalesDeletion(currentSalesMonth, 'order', ordData.id);
					salesModuleData.invoices.push(invData);
					salesModuleData.salesOrders.push(ordData);
				}
			}

			saveSalesDataToStorage();
			const savedEntity = currentEntity;
			clearModalDraft(savedEntity);
			closeModal(true); // skip draft re-save — we just submitted successfully
			clearModalDraft(savedEntity);
			renderSalesPage();
			} finally {
				finalizeSubmit();
			}
		});
	}

	document.addEventListener('click', (event) => {
		const button = event.target.closest('.si-add-btn[data-add-entity]');
		if (button) { openModal(button.getAttribute('data-add-entity'), undefined, false); return; }
		const resumeDraftBtn = event.target.closest('.si-resume-draft-btn[data-draft-entity]');
		if (resumeDraftBtn) { event.stopPropagation(); openModal(resumeDraftBtn.getAttribute('data-draft-entity'), undefined, true); return; }
		const clearDraftBtn = event.target.closest('.si-clear-draft-btn[data-draft-entity]');
		if (clearDraftBtn) {
			event.stopPropagation();
			clearModalDraft(clearDraftBtn.getAttribute('data-draft-entity'));
			renderSalesPage();
			return;
		}
		const editBtn = event.target.closest('.si-edit-btn');
		if (editBtn) {
			event.stopPropagation();
			openModal(editBtn.getAttribute('data-edit-entity'), editBtn.getAttribute('data-edit-id'));
			return;
		}
		const deleteBtn = event.target.closest('.si-delete-btn');
		if (deleteBtn) {
			event.stopPropagation();
			const entity = deleteBtn.getAttribute('data-delete-entity');
			const deleteId = deleteBtn.getAttribute('data-delete-id');
			const label = entity === 'invoice' ? 'invoice' : 'sales order';
			if (!window.confirm('Delete this ' + label + '? This cannot be undone.')) return;
			if (entity === 'invoice') {
				const idx = salesModuleData.invoices.findIndex((inv) => String(inv.id) === String(deleteId));
				const inv = idx >= 0 ? salesModuleData.invoices[idx] : null;
				if (inv) moveAppDataDeleteToTrash('invoices', inv, { kind: 'appDataArray', key: monthStorageKey(currentSalesMonth), arrayPath: 'invoices' });
				if (inv && inv.id) markSalesDeletion(currentSalesMonth, 'invoice', inv.id);
				if (idx >= 0) salesModuleData.invoices.splice(idx, 1);
				if (inv && inv.id) {
					const soIdx = salesModuleData.salesOrders.findIndex((o) => o.sourceInvoiceId === inv.id || o.id === `SO${String(inv.id).slice(3)}`);
					if (soIdx >= 0) {
						markSalesDeletion(currentSalesMonth, 'order', salesModuleData.salesOrders[soIdx].id);
						moveAppDataDeleteToTrash('sales', salesModuleData.salesOrders[soIdx], { kind: 'appDataArray', key: monthStorageKey(currentSalesMonth), arrayPath: 'salesOrders' });
						salesModuleData.salesOrders.splice(soIdx, 1);
					}
				}
				showDeleteToast(`Invoice ${inv ? inv.id : ''} deleted.`);
			} else if (entity === 'order') {
				const idx = salesModuleData.salesOrders.findIndex((ord) => String(ord.id) === String(deleteId));
				const ord = idx >= 0 ? salesModuleData.salesOrders[idx] : null;
				if (ord) moveAppDataDeleteToTrash('sales', ord, { kind: 'appDataArray', key: monthStorageKey(currentSalesMonth), arrayPath: 'salesOrders' });
				if (ord && ord.id) markSalesDeletion(currentSalesMonth, 'order', ord.id);
				if (idx >= 0) salesModuleData.salesOrders.splice(idx, 1);
				showDeleteToast(`Sales order ${ord ? ord.id : ''} deleted.`);
			}
			saveSalesDataToStorage();
			renderSalesPage();
		}
		const approveBtn = event.target.closest('.si-approve-btn');
		if (approveBtn) {
			event.stopPropagation();
			const entity = approveBtn.getAttribute('data-approve-entity');
			const approveId = approveBtn.getAttribute('data-approve-id');
			const nowIso = new Date().toISOString();
			if (entity === 'invoice') {
				const inv = salesModuleData.invoices.find((i) => String(i.id) === String(approveId));
				if (inv) {
					inv.status = inv.requestedStatus || 'pending';
					inv.updatedAt = nowIso;
					delete inv.requestedStatus;
					upsertSalesOrderFromInvoice(inv);
				}
			} else if (entity === 'order') {
				const ord = salesModuleData.salesOrders.find((o) => String(o.id) === String(approveId));
				if (ord) {
					ord.status = ord.requestedStatus || 'confirmed';
					ord.updatedAt = nowIso;
					delete ord.requestedStatus;
					const derivedInvoiceId = `INV${String(ord.id || '').slice(2)}`;
					const inv = salesModuleData.invoices.find((i) => String(i.id) === String(ord.sourceInvoiceId || ''))
						|| salesModuleData.invoices.find((i) => String(i.id) === String(derivedInvoiceId));
					if (inv) {
						inv.status = ord.status;
						inv.updatedAt = nowIso;
					}
				}
			}
			saveSalesDataToStorage();
			renderSalesPage();
		}
	});

	function autoDetectOverdue() {
		const today = new Date(todayStr);
		let changed = false;
		salesModuleData.invoices.forEach((inv) => {
			if (inv.status === 'pending' && inv.paidDate && new Date(inv.paidDate) < today) {
				inv.status = 'overdue';
				inv.updatedAt = new Date().toISOString();
				upsertSalesOrderFromInvoice(inv);
				changed = true;
			}
		});
		salesModuleData.salesOrders.forEach((order) => {
			if (['confirmed', 'processing', 'shipped'].includes(order.status) && order.deliveryDate && new Date(order.deliveryDate) < today) {
				order.status = 'overdue';
				order.updatedAt = new Date().toISOString();
				changed = true;
			}
		});
		if (changed) saveSalesDataToStorage();
	}

	function handleFollowUp(orderId) {
		const order = salesModuleData.salesOrders.find((o) => o.id === orderId);
		if (!order) return;
		const note = prompt(`Follow-up note for ${orderId}:`);
		if (note === null) return;
		if (!order.followUps) order.followUps = [];
		order.followUps.push({ date: todayStr, note });
		saveSalesDataToStorage();
		renderSalesPage();
	}

	function renderSalesPage() {
		autoDetectOverdue();

		const getIdNum = (id) => { const m = String(id || '').match(/(\d+)$/); return m ? Number(m[1]) : 0; };
		const invoiceRows = salesModuleData.invoices.map((invoice, origIdx) => {
			return { ...invoice, _origIdx: origIdx };
		}).sort((a, b) => {
			const dateDiff = String(a.date || '').localeCompare(String(b.date || ''));
			return dateDiff !== 0 ? dateDiff : getIdNum(a.id) - getIdNum(b.id);
		});
		const orders = salesModuleData.salesOrders.map((order, origIdx) => ({ ...order, _origIdx: origIdx })).sort((a, b) => {
			const dateDiff = String(a.orderDate || a.date || '').localeCompare(String(b.orderDate || b.date || ''));
			return dateDiff !== 0 ? dateDiff : getIdNum(a.id) - getIdNum(b.id);
		});

		const totalInvoices = invoiceRows.length;
		const overallSales = getAllSalesData();
		const overallInvoiceCount = Array.isArray(overallSales.invoices) ? overallSales.invoices.length : 0;
		const invoiceRevenue = invoiceRows.filter((inv) => inv.status === 'paid').reduce((sum, inv) => sum + inv.amount, 0);
		const pendingInvoices = invoiceRows.filter((inv) => inv.status === 'pending').reduce((sum, inv) => sum + inv.amount, 0);
		const pendingSales = orders.filter((o) => ['confirmed', 'processing', 'shipped'].includes(o.status)).reduce((sum, o) => sum + Number(o.amount || 0), 0);
		const overdueInvAmt = invoiceRows.filter((inv) => inv.status === 'overdue').reduce((sum, inv) => sum + inv.amount, 0);
		const overdueTotal = overdueInvAmt;

		const stats = document.getElementById('si-stats-row');
		if (stats) {
			const invoicePromo = invoiceRows.reduce((sum, inv) => sum + (inv.promo || 0), 0);
			const totalBagsSold = invoiceRows.reduce((sum, inv) => sum + ((inv.items && inv.items[0] ? inv.items[0].qty : 0) || 0), 0);
			const nonPromoBags = totalBagsSold - invoicePromo;
			const promoExpense = invoiceRows.filter((inv) => inv.status === 'paid').reduce((sum, inv) => {
				const rate = Number(inv.rate || (inv.items && inv.items[0] ? inv.items[0].unitPrice : 0) || 0);
				return sum + (Number(inv.promo || 0) * rate);
			}, 0);
			const hideMoney = window.__wwUserRole === 'supervisor' || window.__wwUserRole === 'staff';
			stats.innerHTML = `
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-file-invoice"></i></div><p class="s-label">Total Invoices (${monthLabel(currentSalesMonth)})</p><p class="s-value">${totalInvoices}</p><p class="s-meta">${orders.length} sales order${orders.length !== 1 ? 's' : ''} in ${monthLabel(currentSalesMonth)} • ${overallInvoiceCount} overall</p></div>
				<div class="stat-card" ${hideMoney ? 'style="display:none"' : ''}><div class="s-icon"><i class="fa-solid fa-dollar-sign"></i></div><p class="s-label">Total Revenue</p><p class="s-value">${formatCurrency(invoiceRevenue)}</p><p class="s-meta split-meta"><span>From paid invoices (gross)</span><span>Promo cost: ${formatCurrency(promoExpense)} (expensed)</span></p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-gift"></i></div><p class="s-label">Total Promo Bags</p><p class="s-value">${formatNumber(invoicePromo)}</p><p class="s-meta split-meta"><span>Total bags: ${formatNumber(totalBagsSold)}</span><span>Non-promo: ${formatNumber(nonPromoBags)}</span><span>Promo: ${formatNumber(invoicePromo)}</span></p></div>
				<div class="stat-card" ${hideMoney ? 'style="display:none"' : ''}><div class="s-icon"><i class="fa-solid fa-clock"></i></div><p class="s-label">Pending</p><p class="s-value">${formatCurrency(pendingInvoices)}</p><p class="s-meta">From pending invoices</p></div>
				<div class="stat-card ${overdueTotal > 0 ? 'stat-card-alert' : ''}" ${hideMoney ? 'style="display:none"' : ''}><div class="s-icon"><i class="fa-solid fa-circle-exclamation"></i></div><p class="s-label">Overdue</p><p class="s-value">${formatCurrency(overdueTotal)}</p><p class="s-meta">${overdueTotal > 0 ? 'From overdue invoices' : 'All clear'}</p></div>
			`;
		}

		const invoiceBody = document.getElementById('invoice-tbody');
		const hideMoney = window.__wwUserRole === 'supervisor' || window.__wwUserRole === 'staff';
		const invoiceDraft = getModalDraft('invoice');
		const orderDraft = getModalDraft('order');
		const selectedInvoiceId = String(window.__wwSelectedInvoiceId || '');
		if (invoiceBody) {
			const draftRow = invoiceDraft ? `
				<tr class="draft-row">
					<td>DRAFT</td>
					<td>${escapeHtml(invoiceDraft.customer || 'Unsaved invoice')}${invoiceDraft.entryTime ? `<small style="display:block;color:#6b7280">${escapeHtml(invoiceDraft.entryTime)}</small>` : ''}</td>
					<td>${escapeHtml(invoiceDraft.promo || '')}</td>
					<td>${escapeHtml(invoiceDraft.qty || '')}</td>
					<td>${hideMoney ? '—' : escapeHtml(invoiceDraft.unitPrice || '')}</td>
					<td>${escapeHtml(formatDateDisplay(invoiceDraft.date || ''))}</td>
					<td>${hideMoney ? '—' : ''}</td>
					<td>${escapeHtml(invoiceDraft.paymentMode || '')}</td>
					<td>${escapeHtml(formatVehicleLabel(invoiceDraft.carType, invoiceDraft.carNumber))}</td>
					<td><span class="status-pill status-orange">Draft (Unsaved)</span></td>
					<td><div class="row-actions"><button class="btn-edit si-resume-draft-btn" data-draft-entity="invoice" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete si-clear-draft-btn" data-draft-entity="invoice" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			` : '';
			invoiceBody.innerHTML = draftRow + invoiceRows.map((invoice) => {
				const statusLabel = invoice.status === 'pending_approval' ? 'Pending Approval' : invoice.status;
				const approveBtn = isApprover && invoice.status === 'pending_approval'
					? `<button class="btn-approve si-approve-btn" data-approve-entity="invoice" data-approve-id="${invoice.id}" title="Approve"><i class="fa-solid fa-check"></i></button>`
					: '';
				return `
					<tr class="selectable" data-invoice-id="${invoice.id}">
						<td>${getInvoiceDisplayId(invoice)}</td>
						<td>${invoice.customer}${invoice.entryTime ? `<small style="display:block;color:#6b7280">${invoice.entryTime}</small>` : ''}</td>
						<td>${invoice.promo ? invoice.promo + (invoice.promoNote ? ' <small style="color:#6b7280">(' + invoice.promoNote + ')</small>' : '') : ''}</td>
						<td>${invoice.items && invoice.items[0] ? invoice.items[0].qty : ''}</td>
						<td>${hideMoney ? '—' : (invoice.rate ? invoice.rate : (invoice.items && invoice.items[0] && invoice.items[0].qty ? (invoice.amount / invoice.items[0].qty).toFixed(1) : ''))}</td>
						<td>${formatDateDisplay(invoice.date)}</td>
						<td>${hideMoney ? '—' : formatCurrency(invoice.amount)}</td>
						<td>${invoice.paymentMode || ''}</td>
						<td>${formatVehicleLabel(invoice.carType, invoice.carNumber)}</td>
						<td><span class="status-pill ${statusPillClass(invoice.status)}">${statusLabel}</span></td>
						<td><div class="row-actions">${approveBtn}<button class="btn-edit si-edit-btn" data-edit-entity="invoice" data-edit-id="${invoice.id}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete si-delete-btn" data-delete-entity="invoice" data-delete-id="${invoice.id}"><i class="fa-solid fa-trash"></i></button></div></td>
					</tr>
				`;
			}).join('');

			invoiceBody.querySelectorAll('tr[data-invoice-id]').forEach((row) => {
				if (selectedInvoiceId && row.getAttribute('data-invoice-id') === selectedInvoiceId) {
					row.classList.add('row-selected');
				}
				row.addEventListener('click', () => {
					invoiceBody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
					row.classList.add('row-selected');
					const invoice = salesModuleData.invoices.find((inv) => inv.id === row.getAttribute('data-invoice-id'));
					renderInvoiceDetail(invoice);
				});
			});
		}

		/* Right-panel: show clickable invoice list instead of empty placeholder */
		const detailContent = document.getElementById('invoice-detail-content');
		if (detailContent) {
			if (invoiceRows.length === 0) {
				window.__wwSelectedInvoiceId = '';
				detailContent.innerHTML = '<p class="detail-placeholder">No invoices yet. Add one to get started.</p>';
			} else if (!detailContent.querySelector('.detail-section')) {
				detailContent.innerHTML = '<ul class="invoice-quick-list">' + invoiceRows.map((inv) => {
					const statusLabel = inv.status === 'pending_approval' ? 'Pending Approval' : inv.status;
					return `<li class="invoice-quick-item" data-qid="${inv.id}">
						<span class="iq-id">${getInvoiceDisplayId(inv)}</span>
						<span class="iq-customer">${inv.customer}</span>
						<span class="iq-amount">${formatCurrency(inv.amount)}</span>
						<span class="status-pill ${statusPillClass(inv.status)}">${statusLabel}</span>
					</li>`;
				}).join('') + '</ul>';
				detailContent.querySelectorAll('.invoice-quick-item').forEach((li) => {
					li.addEventListener('click', () => {
						const inv = salesModuleData.invoices.find((i) => i.id === li.getAttribute('data-qid'));
						if (inv) renderInvoiceDetail(inv);
						/* also highlight the table row */
						if (invoiceBody) {
							invoiceBody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
							const matchRow = invoiceBody.querySelector(`tr[data-invoice-id="${inv.id}"]`);
							if (matchRow) matchRow.classList.add('row-selected');
						}
					});
				});
			}
			if (selectedInvoiceId) {
				const selectedInvoice = salesModuleData.invoices.find((inv) => String(inv.id) === selectedInvoiceId);
				if (selectedInvoice) {
					renderInvoiceDetail(selectedInvoice);
					if (invoiceBody) {
						invoiceBody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
						const matchRow = invoiceBody.querySelector(`tr[data-invoice-id="${selectedInvoice.id}"]`);
						if (matchRow) matchRow.classList.add('row-selected');
					}
				}
			}
		}

		const ordersBody = document.getElementById('orders-tbody');
		if (ordersBody) {
			const draftOrderRow = orderDraft ? `
				<tr class="draft-row">
					<td>DRAFT</td>
					<td>${escapeHtml(orderDraft.customer || 'Unsaved sales order')}</td>
					<td>${escapeHtml(orderDraft.promo || '')}</td>
					<td></td>
					<td>${hideMoney ? '—' : escapeHtml(orderDraft.unitPrice || '')}</td>
					<td>${escapeHtml(formatDateDisplay(orderDraft.orderDate || ''))}</td>
					<td>${hideMoney ? '—' : escapeHtml(orderDraft.amount || '')}</td>
					<td>${escapeHtml(orderDraft.paymentMode || '')}</td>
					<td>${escapeHtml(formatVehicleLabel(orderDraft.carType, orderDraft.carNumber))}</td>
					<td><span class="status-pill status-orange">Draft (Unsaved)</span></td>
					<td><div class="row-actions"><button class="btn-edit si-resume-draft-btn" data-draft-entity="order" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete si-clear-draft-btn" data-draft-entity="order" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			` : '';
			ordersBody.innerHTML = draftOrderRow + orders.map((order) => {
				const showFollowUp = ['overdue', 'confirmed', 'processing', 'shipped'].includes(order.status);
				const followUpCount = (order.followUps && order.followUps.length) || 0;
				const statusLabel = order.status === 'pending_approval' ? 'Pending Approval' : order.status;
				const orderDateDisplay = formatDateDisplay(order.orderDate);
				const deliveryDateNote = order.deliveryDate && order.deliveryDate !== order.orderDate
					? `<small style="display:block;color:#6b7280">Delivery: ${formatDateDisplay(order.deliveryDate)}</small>`
					: '';
				const approveBtn = isApprover && order.status === 'pending_approval'
					? `<button class="btn-approve si-approve-btn" data-approve-entity="order" data-approve-id="${order.id}" title="Approve"><i class="fa-solid fa-check"></i></button>`
					: '';
				return `
					<tr>
						<td>${order.id}</td>
						<td>${order.customer}</td>
						<td>${order.promo ? order.promo + (order.promoNote ? ' <small style="color:#6b7280">(' + order.promoNote + ')</small>' : '') : ''}</td>
						<td>${order.bags || ''}</td>
						<td>${hideMoney ? '—' : (order.rate ? order.rate : (order.bags && order.amount ? (order.amount / order.bags).toFixed(1) : ''))}</td>
						<td>${orderDateDisplay}${deliveryDateNote}</td>
						<td>${hideMoney ? '—' : formatCurrency(order.amount)}</td>
						<td>${order.paymentMode || ''}</td>
						<td>${formatVehicleLabel(order.carType, order.carNumber)}</td>
						<td><span class="status-pill ${statusPillClass(order.status)}">${statusLabel}</span></td>
						<td><div class="row-actions">${approveBtn}<button class="btn-edit si-edit-btn" data-edit-entity="order" data-edit-id="${order.id}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete si-delete-btn" data-delete-entity="order" data-delete-id="${order.id}"><i class="fa-solid fa-trash"></i></button></div></td>
					</tr>
				`;
			}).join('');

			ordersBody.querySelectorAll('.btn-follow-up').forEach((btn) => {
				btn.addEventListener('click', () => handleFollowUp(btn.getAttribute('data-order-id')));
			});
		}
	}

	await refreshSalesMonthFromServer(currentSalesMonth);
	renderSalesPage();

	document.addEventListener('ww-refresh-sales', () => renderSalesPage());
	document.addEventListener('ww-refresh-page', () => { loadMonthData(currentSalesMonth); renderSalesPage(); });

	// ── Cross-device live sync for current sales month ──
	// Pull and apply latest month state continuously so Device B updates automatically
	// when Device A adds/edits/deletes, without manual page refresh.
	if (!window.__wwSalesLiveSyncLoop) {
		window.__wwSalesLiveSyncLoop = true;
		setInterval(async () => {
			try {
				const activePage = document.body.getAttribute('data-page');
				if (activePage !== 'invoices' && activePage !== 'sales') return;
				const month = String(currentSalesMonth || '');
				if (!/^\d{4}-\d{2}$/.test(month)) return;
				await refreshSalesMonthFromServer(month);
			} catch (_e) { /* keep syncing */ }
		}, 1200);
	}

	// ── Online Orders Tab ──
	if (document.getElementById('online-orders-tbody')) {
		loadOnlineOrders();
		// Auto-refresh every 30s
		setInterval(loadOnlineOrders, 30000);
	}
  } catch (err) {
    console.error('[Sales] initSalesInvoicesPage CRASHED:', err);
  }
}

// ── Online Store Orders (Management Side) ──
async function loadOnlineOrders() {
	const tbody = document.getElementById('online-orders-tbody');
	const badge = document.getElementById('online-orders-badge');
	if (!tbody) return;
	if (window.__wwOnlineOrdersLoading) return;
	window.__wwOnlineOrdersLoading = true;

	try {
		const res = await fetch(API_BASE + '/api/store/admin/orders');
		if (!res.ok) {
			tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#587289;padding:24px">Unable to load online orders. Make sure you are logged in.</td></tr>';
			tbody.dataset.ordersSignature = 'error';
			return;
		}
		let orders = await res.json();
		orders = orders.map((o) => ({ ...o, status: o.status === 'Pending' ? 'Confirmed' : o.status }));

		// Apply status filter if set
		const filterSel = document.getElementById('online-status-filter');
		const filterVal = filterSel ? filterSel.value : '';
		if (filterVal) {
			orders = orders.filter((o) => o.status === filterVal);
		}

		// Update badge with active count
		const activeCount = orders.filter((o) => ['Confirmed', 'Processing', 'Dispatched'].includes(o.status)).length;
		if (badge) {
			badge.style.display = activeCount > 0 ? '' : 'none';
			badge.textContent = activeCount;
		}

		const signature = JSON.stringify({
			filterVal,
			rows: orders.map((o) => [o.id, o.status, o.total, o.created_at]),
		});
		if (tbody.dataset.ordersSignature === signature) {
			return;
		}

		if (!orders.length) {
			tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#587289;padding:24px"><i class="fa-solid fa-inbox"></i> No online orders' + (filterVal ? ' matching this filter' : ' yet') + '.</td></tr>';
			tbody.dataset.ordersSignature = signature;
			return;
		}

		tbody.innerHTML = orders.map((o) => {
			const items = o.items.map((i) => `${i.name} ×${i.qty}`).join(', ');
			const date = new Date(o.created_at).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' });
			const statusOpts = ['Confirmed', 'Processing', 'Dispatched', 'Delivered', 'Cancelled']
				.map((s) => `<option value="${s}"${o.status === s ? ' selected' : ''}>${s}</option>`).join('');
			const pillClass = o.status === 'Delivered' ? 'status-green' : o.status === 'Cancelled' ? 'status-red' : (o.status === 'Confirmed' ? 'status-yellow' : 'status-blue');
			return `
				<tr>
					<td><strong>${o.order_code}</strong></td>
					<td>${escapeHtml(o.customerName)}<br><small style="color:#587289">${escapeHtml(o.customerEmail)}</small></td>
					<td>${escapeHtml(o.phone || o.customerPhone)}</td>
					<td style="max-width:200px;font-size:0.85rem">${escapeHtml(items)}</td>
					<td><strong>${formatCurrency(o.total)}</strong></td>
					<td>${date}</td>
					<td><span class="status-pill ${pillClass}">${o.status}</span></td>
					<td><select class="online-status-sel" onchange="updateOnlineOrderStatus(${o.id}, this.value)">${statusOpts}</select></td>
				</tr>
			`;
		}).join('');
		tbody.dataset.ordersSignature = signature;
	} catch (_e) {
		tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#587289;padding:24px">Error loading orders.</td></tr>';
		tbody.dataset.ordersSignature = 'error';
	} finally {
		window.__wwOnlineOrdersLoading = false;
	}
}
window.loadOnlineOrders = loadOnlineOrders;

async function updateOnlineOrderStatus(orderId, newStatus) {
	try {
		const res = await fetch(API_BASE + `/api/store/admin/orders/${orderId}/status`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: newStatus }),
		});
		if (!res.ok) {
			alert('Failed to update status');
			return;
		}
		loadOnlineOrders();
	} catch (_e) {
		alert('Network error updating status');
	}
}
window.updateOnlineOrderStatus = updateOnlineOrderStatus;

function escapeHtml(str) {
	const d = document.createElement('div');
	d.textContent = str || '';
	return d.innerHTML;
}

function renderPoDetail(po) {
	const target = document.getElementById('po-detail-content');
	if (!target || !po) {
		return;
	}

	target.innerHTML = `
		<div class="detail-section">
			<div class="detail-row"><span class="detail-key">PO Number</span><span class="detail-val">${po.id}</span></div>
			<div class="detail-row"><span class="detail-key">Supplier</span><span class="detail-val">${po.supplier}</span></div>
			<div class="detail-row"><span class="detail-key">Order Date</span><span class="detail-val">${po.date}</span></div>
			<div class="detail-row"><span class="detail-key">Expected</span><span class="detail-val">${po.expectedDate}</span></div>
			<div class="detail-row"><span class="detail-key">Status</span><span class="detail-val"><span class="status-pill ${statusPillClass(po.status)}">${po.status}</span></span></div>
		</div>
		<div class="detail-section">
			<p class="detail-section-label">Items</p>
			${po.items.map((item) => {
				return `<div class="line-item-row"><span>${item.name} x ${item.qty}</span><span>${formatCurrency(item.qty * item.unitCost)}</span></div>`;
			}).join('')}
			<div class="line-total"><span>Total</span><span>${formatCurrency(po.amount)}</span></div>
		</div>
	`;
}

/* ---- Purchase Data Persistence ---- */
const purchaseModuleData = { purchaseOrders: [], suppliers: [] };

/* One-time wipe of old seed data */
(function() { localStorage.removeItem('ww_purchase_data'); })();

function loadPurchaseDataFromStorage() {
	try {
		const stored = JSON.parse(localStorage.getItem('ww_purchase_data_v2') || 'null');
		if (stored && typeof stored === 'object') {
			purchaseModuleData.purchaseOrders = Array.isArray(stored.purchaseOrders) ? stored.purchaseOrders : [];
			purchaseModuleData.suppliers = Array.isArray(stored.suppliers) ? stored.suppliers : [];
		}
	} catch (_e) { /* ignore */ }
}

function savePurchaseDataToStorage() {
	localStorage.setItem('ww_purchase_data_v2', JSON.stringify(purchaseModuleData));
	syncToServer('ww_purchase_data_v2', purchaseModuleData);
	try {
		if (!window.__wwPurchaseChannel) window.__wwPurchaseChannel = new BroadcastChannel('ww_purchase_sync');
		window.__wwPurchaseChannel.postMessage({ type: 'purchase_updated' });
	} catch (_e) { /* fallback to storage event */ }
}

function nextPoId() {
	const nums = purchaseModuleData.purchaseOrders.map((po) => {
		const match = String(po.id).match(/(\d+)$/);
		return match ? Number(match[1]) : 0;
	});
	return `PO-${new Date().getFullYear()}-${String((Math.max(0, ...nums) + 1)).padStart(3, '0')}`;
}

function nextSupplierId() {
	const nums = purchaseModuleData.suppliers.map((s) => {
		const match = String(s.id).match(/(\d+)$/);
		return match ? Number(match[1]) : 0;
	});
	return `SUP-${String((Math.max(0, ...nums) + 1)).padStart(3, '0')}`;
}

function poTotal(po) {
	if (!po.items || !po.items.length) return Number(po.amount || 0);
	return po.items.reduce((sum, item) => sum + (item.qty * item.unitCost), 0);
}

function initPurchasePage() {
	if (document.body.getAttribute('data-page') !== 'vendors') {
		return;
	}

	loadPurchaseDataFromStorage();
	const todayStr = getTodayDateStr();

	const PU_MODAL_CONFIGS = {
		po: {
			title: 'Add Purchase Order',
			fields: [
				{ id: 'supplier', label: 'Supplier', type: 'supplier-select', required: true },
				{ id: 'item', label: 'Item Name', type: 'text', required: true, placeholder: 'e.g. Filter Cartridges' },
				{ id: 'qty', label: 'Quantity', type: 'number', min: '1', required: true },
				{ id: 'unitCost', label: 'Unit Cost (GH)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'date', label: 'Order Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'expectedDate', label: 'Expected Delivery', type: 'date', required: true },
				{ id: 'status', label: 'Status', type: 'select', options: ['pending', 'confirmed', 'shipped', 'delivered'], required: true },
			],
		},
		supplier: {
			title: 'Add Supplier',
			fields: [
				{ id: 'name', label: 'Supplier Name', type: 'text', required: true },
				{ id: 'contact', label: 'Phone', type: 'text', required: true, placeholder: '024-000-0000' },
				{ id: 'email', label: 'Email', type: 'email', required: true, placeholder: 'contact@supplier.com' },
				{ id: 'materials', label: 'Materials Supplied', type: 'text', required: true, placeholder: 'e.g. Packaging, Labels' },
				{ id: 'terms', label: 'Payment Terms', type: 'select', options: ['COD', 'Net 15', 'Net 21', 'Net 30', 'Net 45', 'Net 60'], required: true },
			],
		},
	};

	const addModal = document.getElementById('pu-add-modal');
	const modalTitle = document.getElementById('pu-modal-title');
	const modalFieldsEl = document.getElementById('pu-modal-fields');
	const modalForm = document.getElementById('pu-add-form');
	let currentEntity = null;
	let editingId = null;
	const puDraftStorageKey = (entity) => `ww_purchase_modal_draft_${entity}`;

	const clearModalValidation = () => {
		if (!modalFieldsEl) return;
		modalFieldsEl.querySelectorAll('.inv-modal-field').forEach((field) => field.classList.remove('has-error'));
		modalFieldsEl.querySelectorAll('.inv-modal-error').forEach((msg) => { msg.textContent = ''; });
		const summary = modalFieldsEl.querySelector('#pu-modal-error-summary');
		if (summary) summary.textContent = '';
	};

	const setFieldValidationError = (fieldId, message) => {
		const input = document.getElementById(`pu-field-${fieldId}`);
		if (!input) return;
		const fieldWrap = input.closest('.inv-modal-field');
		if (fieldWrap) fieldWrap.classList.add('has-error');
		const msgEl = document.getElementById(`pu-err-${fieldId}`);
		if (msgEl) msgEl.textContent = message;
	};

	const validateModalRequiredFields = (options) => {
		const opts = options || {};
		const focusFirst = opts.focusFirst !== false;
		const showSummary = opts.showSummary !== false;
		const config = PU_MODAL_CONFIGS[currentEntity];
		if (!config) return true;
		clearModalValidation();
		const missing = [];
		for (const field of config.fields) {
			if (!field.required) continue;
			const el = document.getElementById(`pu-field-${field.id}`);
			if (!el || el.disabled) continue;
			const value = String(el.value || '').trim();
			if (value) continue;
			missing.push(field);
			setFieldValidationError(field.id, `${field.label} is required.`);
		}
		if (!missing.length) return true;
		const summary = modalFieldsEl ? modalFieldsEl.querySelector('#pu-modal-error-summary') : null;
		if (summary && showSummary) summary.textContent = 'Please fill the highlighted required fields.';
		if (focusFirst) {
			const firstMissing = document.getElementById(`pu-field-${missing[0].id}`);
			if (firstMissing) firstMissing.focus();
		}
		return false;
	};

	const saveModalDraft = (entity) => {
		if (!entity || editingId) return;
		const config = PU_MODAL_CONFIGS[entity];
		if (!config) return;
		const values = {};
		config.fields.forEach((field) => {
			const el = document.getElementById(`pu-field-${field.id}`);
			if (!el || el.disabled) return;
			values[field.id] = el.value;
		});
		try {
			localStorage.setItem(puDraftStorageKey(entity), JSON.stringify({ values, ts: Date.now() }));
		} catch (_e) { /* ignore */ }
	};

	const clearModalDraft = (entity) => {
		if (!entity) return;
		try { localStorage.removeItem(puDraftStorageKey(entity)); } catch (_e) { /* ignore */ }
	};

	const restoreModalDraft = (entity) => {
		if (!entity || editingId) return;
		try {
			const raw = localStorage.getItem(puDraftStorageKey(entity));
			if (!raw) return;
			const parsed = JSON.parse(raw);
			const values = parsed && parsed.values ? parsed.values : null;
			if (!values || typeof values !== 'object') return;
			Object.keys(values).forEach((fieldId) => {
				const el = document.getElementById(`pu-field-${fieldId}`);
				if (!el || el.disabled) return;
				if (!String(el.value || '').trim() && values[fieldId] !== undefined && values[fieldId] !== null) {
					el.value = String(values[fieldId]);
				}
			});
		} catch (_e) { /* ignore */ }
	};

	const getModalDraft = (entity) => {
		if (!entity) return null;
		try {
			const raw = localStorage.getItem(puDraftStorageKey(entity));
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			const values = parsed && parsed.values ? parsed.values : null;
			if (!values || typeof values !== 'object') return null;
			const hasAnyValue = Object.values(values).some((v) => String(v || '').trim() !== '');
			return hasAnyValue ? values : null;
		} catch (_e) {
			return null;
		}
	};

	const bindModalLiveHandlers = () => {
		if (!modalFieldsEl) return;
		const controls = modalFieldsEl.querySelectorAll('input, select, textarea');
		controls.forEach((ctrl) => {
			const syncState = () => {
				saveModalDraft(currentEntity);
				validateModalRequiredFields({ focusFirst: false, showSummary: false });
			};
			ctrl.addEventListener('input', syncState);
			ctrl.addEventListener('change', syncState);
			ctrl.addEventListener('blur', () => {
				validateModalRequiredFields({ focusFirst: false, showSummary: false });
			});
		});
	};

	const closeModal = (skipDraft = false) => {
		const savedEntity = currentEntity;
		const wasAdding = !editingId;
		if (!skipDraft && wasAdding && savedEntity) saveModalDraft(savedEntity);
		if (addModal) addModal.style.display = 'none';
		if (modalForm) modalForm.reset();
		clearModalValidation();
		currentEntity = null;
		editingId = null;
		if (wasAdding && savedEntity) renderPurchasePage();
	};

	window.addEventListener('beforeunload', () => { if (!editingId && currentEntity) saveModalDraft(currentEntity); });

	const openModal = (entity, existingId, resumeDraft = false) => {
		const config = PU_MODAL_CONFIGS[entity];
		if (!config || !addModal) return;
		currentEntity = entity;
		editingId = existingId || null;
		if (modalTitle) modalTitle.textContent = editingId ? config.title.replace('Add', 'Edit') : config.title;
		if (modalFieldsEl) {
			modalFieldsEl.innerHTML = `<p class="inv-modal-summary-error" id="pu-modal-error-summary" aria-live="polite"></p>` + config.fields.map((f) => {
				if (f.type === 'supplier-select') {
					const opts = purchaseModuleData.suppliers.map((s) => `<option value="${s.name}">${s.name}</option>`).join('');
					if (!purchaseModuleData.suppliers.length) {
						return `<div class="inv-modal-field"><label for="pu-field-${f.id}">${f.label} <span class="req">*</span></label><select id="pu-field-${f.id}" name="${f.id}" required disabled><option value="">No suppliers yet — add one first</option></select><p class="inv-modal-error" id="pu-err-${f.id}" aria-live="polite"></p></div>`;
					}
					return `<div class="inv-modal-field"><label for="pu-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><select id="pu-field-${f.id}" name="${f.id}" ${f.required ? 'required' : ''}><option value="">Select a supplier</option>${opts}</select><p class="inv-modal-error" id="pu-err-${f.id}" aria-live="polite"></p></div>`;
				}
				if (f.type === 'select') {
					return `<div class="inv-modal-field"><label for="pu-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><select id="pu-field-${f.id}" name="${f.id}" ${f.required ? 'required' : ''}>${f.options.map((o) => `<option value="${o}">${o.charAt(0).toUpperCase() + o.slice(1)}</option>`).join('')}</select><p class="inv-modal-error" id="pu-err-${f.id}" aria-live="polite"></p></div>`;
				}
				return `<div class="inv-modal-field"><label for="pu-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><input id="pu-field-${f.id}" type="${f.type}" name="${f.id}" ${f.required ? 'required' : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} ${f.defaultValue ? `value="${f.defaultValue}"` : ''}><p class="inv-modal-error" id="pu-err-${f.id}" aria-live="polite"></p></div>`;
			}).join('');
		}
		/* Pre-fill fields when editing */
		if (editingId) {
			if (entity === 'po') {
				const po = purchaseModuleData.purchaseOrders.find((p) => p.id === editingId);
				if (po) {
					const setVal = (id, v) => { const el = document.getElementById(`pu-field-${id}`); if (el) el.value = v || ''; };
					setVal('supplier', po.supplier);
					setVal('item', po.items && po.items[0] ? po.items[0].name : '');
					setVal('qty', po.items && po.items[0] ? po.items[0].qty : '');
					setVal('unitCost', po.items && po.items[0] ? po.items[0].unitCost : '');
					setVal('date', po.date);
					setVal('expectedDate', po.expectedDate);
					setVal('status', po.status);
				}
			}
			if (entity === 'supplier') {
				const sup = purchaseModuleData.suppliers.find((s) => s.id === editingId);
				if (sup) {
					const setVal = (id, v) => { const el = document.getElementById(`pu-field-${id}`); if (el) el.value = v || ''; };
					setVal('name', sup.name);
					setVal('contact', sup.contact);
					setVal('email', sup.email);
					setVal('materials', sup.materials);
					setVal('terms', sup.terms);
				}
			}
		}
		addModal.style.display = 'flex';
		const firstInput = modalFieldsEl && modalFieldsEl.querySelector('input, select');
		if (resumeDraft) restoreModalDraft(entity);
		if (firstInput) firstInput.focus();
		bindModalLiveHandlers();
		validateModalRequiredFields({ focusFirst: false, showSummary: false });
	};

	document.getElementById('pu-modal-close')?.addEventListener('click', closeModal);
	document.getElementById('pu-modal-cancel')?.addEventListener('click', closeModal);
	addModal?.addEventListener('click', (e) => { if (e.target === addModal) closeModal(); });

	const getValue = (id) => { const el = document.getElementById(`pu-field-${id}`); return el ? el.value.trim() : ''; };
	const getNum = (id) => { const v = Number(getValue(id)); return Number.isFinite(v) && v >= 0 ? v : 0; };

	if (modalForm && !modalForm.dataset.bound) {
		modalForm.dataset.bound = '1';
		modalForm.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!currentEntity) return;
			if (!validateModalRequiredFields()) return;

			if (currentEntity === 'po') {
				const supplier = getValue('supplier');
				const item = getValue('item');
				if (!supplier || !item) return;
				if (editingId) {
					const po = purchaseModuleData.purchaseOrders.find((p) => p.id === editingId);
					if (po) {
						po.supplier = supplier;
						po.date = getValue('date') || todayStr;
						po.expectedDate = getValue('expectedDate') || todayStr;
						po.status = getValue('status') || 'pending';
						po.items = [{ name: item, qty: getNum('qty') || 1, unitCost: getNum('unitCost') }];
					}
				} else {
					purchaseModuleData.purchaseOrders.push({
						id: nextPoId(),
						supplier,
						date: getValue('date') || todayStr,
						expectedDate: getValue('expectedDate') || todayStr,
						status: getValue('status') || 'pending',
						items: [{ name: item, qty: getNum('qty') || 1, unitCost: getNum('unitCost') }],
					});
				}
			}

			if (currentEntity === 'supplier') {
				const name = getValue('name');
				if (!name) return;
				if (editingId) {
					const sup = purchaseModuleData.suppliers.find((s) => s.id === editingId);
					if (sup) {
						sup.name = name;
						sup.contact = getValue('contact');
						sup.email = getValue('email');
						sup.materials = getValue('materials');
						sup.terms = getValue('terms') || 'Net 30';
					}
				} else {
					purchaseModuleData.suppliers.push({
						id: nextSupplierId(),
						name,
						contact: getValue('contact'),
						email: getValue('email'),
						materials: getValue('materials'),
						terms: getValue('terms') || 'Net 30',
						rating: 0,
					});
				}
			}

			savePurchaseDataToStorage();
			clearModalDraft(currentEntity);
			closeModal(true); // skipDraft=true — data saved, don't re-save draft
			renderPurchasePage();
		});
	}

	document.addEventListener('click', (event) => {
		const addBtn = event.target.closest('.pu-add-btn[data-add-entity]');
		if (addBtn) { openModal(addBtn.getAttribute('data-add-entity'), null, false); return; }
		const resumeDraftBtn = event.target.closest('.pu-resume-draft-btn[data-draft-entity]');
		if (resumeDraftBtn) { event.stopPropagation(); openModal(resumeDraftBtn.getAttribute('data-draft-entity'), null, true); return; }
		const clearDraftBtn = event.target.closest('.pu-clear-draft-btn[data-draft-entity]');
		if (clearDraftBtn) {
			event.stopPropagation();
			clearModalDraft(clearDraftBtn.getAttribute('data-draft-entity'));
			renderPurchasePage();
			return;
		}
		const editBtn = event.target.closest('.pu-edit-btn');
		if (editBtn) {
			event.stopPropagation();
			openModal(editBtn.getAttribute('data-edit-entity'), editBtn.getAttribute('data-edit-id'));
		}
		const deleteBtn = event.target.closest('.pu-delete-btn');
		if (deleteBtn) {
			event.stopPropagation();
			const entity = deleteBtn.getAttribute('data-delete-entity');
			const id = deleteBtn.getAttribute('data-delete-id');
			const label = entity === 'po' ? 'purchase order' : 'supplier';
			if (!window.confirm('Delete this ' + label + '? This cannot be undone.')) return;
			if (entity === 'po') {
				const removedPo = purchaseModuleData.purchaseOrders.find((po) => po.id === id);
				if (removedPo) moveAppDataDeleteToTrash('purchaseOrders', removedPo, { kind: 'appDataArray', key: 'ww_purchase_data_v2', arrayPath: 'purchaseOrders' });
				purchaseModuleData.purchaseOrders = purchaseModuleData.purchaseOrders.filter((po) => po.id !== id);
				showDeleteToast(`Purchase order ${id} deleted.`);
			} else if (entity === 'supplier') {
				const removedSupplier = purchaseModuleData.suppliers.find((s) => s.id === id);
				if (removedSupplier) moveAppDataDeleteToTrash('vendors', removedSupplier, { kind: 'appDataArray', key: 'ww_purchase_data_v2', arrayPath: 'suppliers' });
				purchaseModuleData.suppliers = purchaseModuleData.suppliers.filter((s) => s.id !== id);
				showDeleteToast(`Supplier "${removedSupplier ? removedSupplier.name : id}" removed.`);
			}
			savePurchaseDataToStorage();
			renderPurchasePage();
		}
	});

	function renderPurchasePage() {
		const orders = purchaseModuleData.purchaseOrders.map((po) => ({ ...po, amount: poTotal(po) }));
		const suppliers = purchaseModuleData.suppliers;
		const poDraft = getModalDraft('po');
		const supplierDraft = getModalDraft('supplier');

		const activePos = orders.filter((po) => po.status !== 'delivered');
		const pendingCount = orders.filter((po) => po.status === 'pending').length;
		const confirmedCount = orders.filter((po) => po.status === 'confirmed').length;
		const deliveredCount = orders.filter((po) => po.status === 'delivered').length;
		const totalSpent = orders.reduce((sum, po) => sum + po.amount, 0);
		const inTransitOrders = orders.filter((po) => ['confirmed', 'shipped'].includes(po.status));

		const stats = document.getElementById('pu-stats-row');
		if (stats) {
			stats.innerHTML = `
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-file-lines"></i></div><p class="s-label">Active POs</p><p class="s-value">${activePos.length}</p><p class="s-meta split-meta"><span>Pending: ${pendingCount}</span><span>Confirmed: ${confirmedCount}</span><span>Delivered: ${deliveredCount}</span></p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-truck"></i></div><p class="s-label">Suppliers</p><p class="s-value">${suppliers.length}</p><p class="s-meta">Approved vendors</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-coins"></i></div><p class="s-label">Total Spent</p><p class="s-value">${formatCurrency(totalSpent)}</p><p class="s-meta">Across all purchase orders</p></div>
				<div class="stat-card ${inTransitOrders.length > 0 ? 'stat-card-warning' : ''}"><div class="s-icon"><i class="fa-solid fa-truck-moving"></i></div><p class="s-label">In Transit</p><p class="s-value">${inTransitOrders.length}</p><p class="s-meta">${inTransitOrders.length > 0 ? inTransitOrders.map((o) => o.id).join(', ') : 'No orders in transit'}</p></div>
			`;
		}

		const poBody = document.getElementById('po-tbody');
		if (poBody) {
			const poDraftRow = poDraft ? `
				<tr class="draft-row">
					<td>DRAFT</td>
					<td>${escapeHtml(poDraft.supplier || 'Unsaved PO')}</td>
					<td>${escapeHtml(formatDateDisplay(poDraft.date || ''))}</td>
					<td>${escapeHtml(formatDateDisplay(poDraft.expectedDate || ''))}</td>
					<td></td>
					<td><span class="status-pill status-orange">Draft (Unsaved)</span></td>
					<td><div class="row-actions"><button class="btn-edit pu-resume-draft-btn" data-draft-entity="po" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete pu-clear-draft-btn" data-draft-entity="po" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			` : '';
			poBody.innerHTML = poDraftRow + orders.map((po) => {
				return `
					<tr class="selectable" data-po-id="${po.id}">
						<td>${po.id}</td>
						<td>${po.supplier}</td>
						<td>${po.date}</td>
						<td>${po.expectedDate}</td>
						<td>${formatCurrency(po.amount)}</td>
						<td><span class="status-pill ${statusPillClass(po.status)}">${po.status}</span></td>
						<td><div class="row-actions"><button class="btn-edit pu-edit-btn" data-edit-entity="po" data-edit-id="${po.id}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete pu-delete-btn" data-delete-entity="po" data-delete-id="${po.id}"><i class="fa-solid fa-trash"></i></button></div></td>
					</tr>
				`;
			}).join('');

			poBody.querySelectorAll('tr[data-po-id]').forEach((row) => {
				row.addEventListener('click', () => {
					poBody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
					row.classList.add('row-selected');
					const po = orders.find((value) => value.id === row.getAttribute('data-po-id'));
					renderPoDetail(po);
				});
			});
		}

		/* Right panel: list all POs for quick access */
		const detailContent = document.getElementById('po-detail-content');
		if (detailContent) {
			if (orders.length === 0) {
				detailContent.innerHTML = '<p class="detail-placeholder">No purchase orders yet. Add one to get started.</p>';
			} else if (!detailContent.querySelector('.detail-section')) {
				detailContent.innerHTML = '<ul class="invoice-quick-list">' + orders.map((po) => {
					return `<li class="invoice-quick-item" data-qid="${po.id}">
						<span class="iq-id">${po.id}</span>
						<span class="iq-customer">${po.supplier}</span>
						<span class="iq-amount">${formatCurrency(po.amount)}</span>
						<span class="status-pill ${statusPillClass(po.status)}">${po.status}</span>
					</li>`;
				}).join('') + '</ul>';
				detailContent.querySelectorAll('.invoice-quick-item').forEach((li) => {
					li.addEventListener('click', () => {
						const po = orders.find((p) => p.id === li.getAttribute('data-qid'));
						if (po) renderPoDetail(po);
						if (poBody) {
							poBody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
							const matchRow = poBody.querySelector(`tr[data-po-id="${po.id}"]`);
							if (matchRow) matchRow.classList.add('row-selected');
						}
					});
				});
			}
		}

		const suppliersBody = document.getElementById('suppliers-tbody');
		if (suppliersBody) {
			const supplierDraftRow = supplierDraft ? `
				<tr class="draft-row">
					<td>${escapeHtml(supplierDraft.name || 'Unsaved supplier')}</td>
					<td>${escapeHtml(supplierDraft.contact || '')}</td>
					<td>${escapeHtml(supplierDraft.email || '')}</td>
					<td>${escapeHtml(supplierDraft.materials || '')}</td>
					<td></td>
					<td><span class="badge badge-orange">Draft</span></td>
					<td>Unsaved</td>
					<td><div class="row-actions"><button class="btn-edit pu-resume-draft-btn" data-draft-entity="supplier" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete pu-clear-draft-btn" data-draft-entity="supplier" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			` : '';
			suppliersBody.innerHTML = supplierDraftRow + suppliers.map((supplier) => {
				const orderCount = orders.filter((po) => po.supplier === supplier.name).length;
				const stars = supplier.rating > 0 ? '★'.repeat(Math.round(supplier.rating)) : '—';
				return `
					<tr>
						<td>${supplier.name}</td>
						<td>${supplier.contact}</td>
						<td>${supplier.email}</td>
						<td>${supplier.materials}</td>
						<td>${orderCount}</td>
						<td><span class="badge badge-blue">${supplier.terms}</span></td>
						<td>${supplier.rating > 0 ? `<span class="stars">${stars}</span> ${supplier.rating.toFixed(1)}` : 'New'}</td>
						<td><div class="row-actions"><button class="btn-edit pu-edit-btn" data-edit-entity="supplier" data-edit-id="${supplier.id}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete pu-delete-btn" data-delete-entity="supplier" data-delete-id="${supplier.id}"><i class="fa-solid fa-trash"></i></button></div></td>
					</tr>
				`;
			}).join('');
		}
	}

	renderPurchasePage();

	if (!window.__wwPurchaseSyncBound) {
		window.__wwPurchaseSyncBound = true;
		const reloadPurchasePage = () => {
			loadPurchaseDataFromStorage();
			renderPurchasePage();
		};
		window.addEventListener('storage', (event) => {
			if (event.key === 'ww_purchase_data_v2') reloadPurchasePage();
		});
		try {
			if (!window.__wwPurchaseChannel) window.__wwPurchaseChannel = new BroadcastChannel('ww_purchase_sync');
			window.__wwPurchaseChannel.onmessage = reloadPurchasePage;
		} catch (_e) { /* ignore */ }
	}
	document.addEventListener('ww-refresh-page', renderPurchasePage);
}

/* ---- Accounting Data Persistence ---- */
const accountingData = { ledger: [], cashbook: [], summary: [], currencies: [], salaries: [], assets: [] };

(function() { localStorage.removeItem('ww_accounting_data'); })();

function loadAccountingDataFromStorage() {
	try {
		const stored = JSON.parse(localStorage.getItem('ww_accounting_data_v2') || 'null');
		if (stored && typeof stored === 'object') {
			accountingData.ledger = Array.isArray(stored.ledger) ? stored.ledger : [];
			accountingData.cashbook = Array.isArray(stored.cashbook) ? stored.cashbook : [];
			accountingData.summary = Array.isArray(stored.summary) ? stored.summary : [];
			accountingData.currencies = Array.isArray(stored.currencies) ? stored.currencies : [];
			accountingData.salaries = Array.isArray(stored.salaries) ? stored.salaries : [];
			accountingData.assets = Array.isArray(stored.assets) ? stored.assets : [];
		}
	} catch (_e) { /* ignore */ }

	// Normalize salary grouping: only March 2026 remains weekly; later months persist as monthly.
	let normalizedSalaryCount = 0;
	accountingData.salaries.forEach((row) => {
		if (!row || typeof row !== 'object') return;
		let monthFromWeekEnd = '';
		if (row.week) {
			const weekEndDate = new Date(String(row.week) + 'T00:00:00');
			weekEndDate.setDate(weekEndDate.getDate() + 6);
			monthFromWeekEnd = weekEndDate.toISOString().slice(0, 7);
		}
		const inferredMonth = row.month
			? String(row.month).slice(0, 7)
			: (monthFromWeekEnd || String(row.date || '').slice(0, 7));
		if (!row.month && inferredMonth) {
			row.month = inferredMonth;
			normalizedSalaryCount += 1;
		}
		if (row.week && !(String(row.week) >= '2026-03-01' && String(row.week) < '2026-03-30')) {
			delete row.week;
			normalizedSalaryCount += 1;
		}
	});
	if (normalizedSalaryCount > 0) saveAccountingDataToStorage();

	// One-time seed: March 2026 operational costs
	if (!getSeedFlag('opscost_march2026') && accountingData.ledger.length === 0) {
		seedMarchOperationalCosts();
		setSeedFlag('opscost_march2026');
		saveAccountingDataToStorage();
	} else if (!getSeedFlag('opscost_march2026')) {
		setSeedFlag('opscost_march2026');
	}

	// One-time seed: March 2026 salaries (v5 = 18k/week on Assets sheet)
	if (!getSeedFlag('salaries_march2026_v5')) {
		if (accountingData.salaries.length === 0) {
		// Remove old individual salary ledger entries
		accountingData.ledger = accountingData.ledger.filter(e => !(e.account === 'Salaries' && e.desc && e.desc.startsWith('Salary —')));
		// Remove old aggregate salary ledger/cashbook entries
		accountingData.ledger = accountingData.ledger.filter(e => !(e.account === 'Salaries & Wages'));
		accountingData.cashbook = accountingData.cashbook.filter(e => !(e.desc && e.desc.startsWith('Salaries & Wages')));
		// Remove old salary assets (if any from v4)
		accountingData.assets = accountingData.assets.filter(e => !(e.category === 'Salaries & Wages'));
		accountingData.salaries = [];
		seedMarchSalaries();
		setSeedFlag('salaries_march2026_v5');
		saveAccountingDataToStorage();
		}
		setSeedFlag('salaries_march2026_v5');
	}
}

function seedMarchOperationalCosts() {
	const rows = [
		// 18 March 2026
		{ d:'2026-03-18', desc:'Fuel for Truck 1 (3.5t)', amt:500, acc:'Transport' },
		{ d:'2026-03-18', desc:'Plumbing items', amt:335, acc:'Maintenance' },
		{ d:'2026-03-18', desc:'Filters and delivery', amt:880, acc:'Production' },
		{ d:'2026-03-18', desc:'Banners and delivery', amt:286, acc:'Marketing' },
		{ d:'2026-03-18', desc:'Fuel/Maintenance Tricycles', amt:350, acc:'Transport' },
		{ d:'2026-03-18', desc:'Automated guy', amt:150, acc:'Maintenance' },
		{ d:'2026-03-18', desc:'Pump Delivery', amt:80, acc:'Transport' },
		// 19 March 2026
		{ d:'2026-03-19', desc:'Fuel for Truck 1 (3.0t)', amt:500, acc:'Transport' },
		{ d:'2026-03-19', desc:'Packaging bags (2 bags) + Delivery', amt:920, acc:'Production', note:'840 + 80' },
		{ d:'2026-03-19', desc:'Fuel for Lexus', amt:500, acc:'Transport', note:'Crossed out / queried' },
		// 20 March 2026
		{ d:'2026-03-20', desc:'Fuel for Truck (3.5t)', amt:500, acc:'Transport' },
		{ d:'2026-03-20', desc:'Refuse collection', amt:100, acc:'Administration' },
		{ d:'2026-03-20', desc:'Refreshments for workers', amt:150, acc:'Administration' },
		{ d:'2026-03-20', desc:'Pump for R.O', amt:4200, acc:'Production', note:'Crossed out; c16131 noted' },
		// 21 March 2026
		{ d:'2026-03-21', desc:'Pump Glen for R.O (6.1m)', amt:7200, acc:'Production' },
		{ d:'2026-03-21', desc:'Bore hole pump 2.0hp', amt:2400, acc:'Production' },
		{ d:'2026-03-21', desc:'Electricity', amt:5000, acc:'Utilities' },
		{ d:'2026-03-21', desc:'Truck Clutch (3.0t)', amt:450, acc:'Transport' },
		// 23 March 2026
		{ d:'2026-03-23', desc:'Baskets, crocs, tap bowls', amt:2500, acc:'Production' },
		// 24 March 2026
		{ d:'2026-03-24', desc:'Road control for Kia Mighty (3.5t) + Talo delivery', amt:175, acc:'Transport' },
		{ d:'2026-03-24', desc:'Plumbing items / Pipes', amt:278, acc:'Maintenance', note:'21/3/26' },
		{ d:'2026-03-24', desc:'Plumbing items', amt:270, acc:'Maintenance', note:'23/3/26' },
		{ d:'2026-03-24', desc:'Automated timer + Workmanship', amt:595, acc:'Maintenance', note:'22/3/26; ₵1318 paid to Expo' },
		{ d:'2026-03-24', desc:'Health workers log @₵120/wk x 10 workers', amt:1320, acc:'Salaries', note:'4 baggers, 3 loaders, 2 packers, 1 operator, 1 cleaner' },
		{ d:'2026-03-24', desc:'Transportation', amt:100, acc:'Transport' },
		// 25 March 2026
		{ d:'2026-03-25', desc:'Fuel ① (3.5t truck)', amt:500, acc:'Transport' },
		{ d:'2026-03-25', desc:'Fuel ② (Abofryas)', amt:450, acc:'Transport' },
		{ d:'2026-03-25', desc:'Packaging bags', amt:6030, acc:'Production' },
		{ d:'2026-03-25', desc:'Rolls', amt:23101.20, acc:'Production' },
		{ d:'2026-03-25', desc:'Bank charges', amt:55.60, acc:'Administration' },
		// 27 March 2026
		{ d:'2026-03-27', desc:'Fuel (GT 5t) (3.5t)', amt:500, acc:'Transport' },
		// 28 March 2026
		{ d:'2026-03-28', desc:'Noah - items for R.O', amt:560, acc:'Production' },
		{ d:'2026-03-28', desc:'Noah - cleaner & membrane', amt:1200, acc:'Production' },
		{ d:'2026-03-28', desc:'Fuel - Abofryas', amt:100, acc:'Transport' },
		{ d:'2026-03-28', desc:'Pump tyres - Abofryas', amt:45, acc:'Transport' },
		{ d:'2026-03-28', desc:'2pcs Union x2', amt:52, acc:'Maintenance' },
		{ d:'2026-03-28', desc:'Plumbing supply', amt:46, acc:'Maintenance' },
		{ d:'2026-03-28', desc:'Fuel ~₵500 (GT 5320-24 small truck)', amt:500, acc:'Transport' },
	];

	for (const r of rows) {
		// Add to ledger as expense
		accountingData.ledger.push({
			date: r.d,
			desc: r.note ? `${r.desc} — ${r.note}` : r.desc,
			account: r.acc,
			type: 'expense',
			debit: r.amt,
			credit: 0
		});
		// Add to cashbook as payment
		accountingData.cashbook.push({
			date: r.d,
			desc: r.note ? `${r.desc} — ${r.note}` : r.desc,
			kind: 'payment',
			amount: r.amt
		});
	}
}

function seedMarchSalaries() {
	const rows = [
		// Week of 16 Mar (Mon 16th – Sun 22nd)
		{ d:'2026-03-21', name:'Ernest Boateng', week:'2026-03-16', amt:600, note:'Overpaid; 400 bags @120 to be subtracted next salary' },
		// Week of 23 Mar (Mon 23rd – Sun 29th)
		{ d:'2026-03-28', name:'Ernest Boateng', week:'2026-03-23', amt:240, note:'1,450 bags − 400 bags last week = ₵315 − ₵75 left = ₵240' },
		{ d:'2026-03-28', name:'Michael Dagadu', week:'2026-03-23', amt:1095, note:'₵615 (bags) + ₵480 (trips x2) = ₵1,095' },
		{ d:'2026-03-28', name:'Mary Teye', week:'2026-03-23', amt:829.50, note:'Paid' },
		{ d:'2026-03-28', name:'Ivy Ekemegbe', week:'2026-03-23', amt:802.50, note:'Paid' },
		{ d:'2026-03-28', name:'Vida Sackey', week:'2026-03-23', amt:540, note:'Paid' },
		{ d:'2026-03-28', name:'Love Konotey', week:'2026-03-23', amt:540, note:'Paid' },
		{ d:'2026-03-28', name:'Christopher Lawer', week:'2026-03-23', amt:915, note:'Paid' },
		{ d:'2026-03-28', name:'Augustine Konotey', week:'2026-03-23', amt:720, note:'Minus 3 days (19th, 21st, 22nd)' },
		{ d:'2026-03-28', name:'John Nyarko', week:'2026-03-23', amt:415, note:'Minus 1 day (28th)' },
		{ d:'2026-03-28', name:'Wisdom Xorlali', week:'2026-03-23', amt:1250, note:'Paid' },
		{ d:'2026-03-28', name:'Bright Azaglo', week:'2026-03-23', amt:2500, note:'' },
		{ d:'2026-03-28', name:'Jonas (Loader)', week:'2026-03-23', amt:700, note:'' },
		{ d:'2026-03-28', name:'Ever (Loader)', week:'2026-03-23', amt:700, note:'' },
		{ d:'2026-03-28', name:'Alfred (Loader)', week:'2026-03-23', amt:700, note:'' },
	];

	// Individual salary breakdown (salary tab only — not added to ledger)
	for (const r of rows) {
		accountingData.salaries.push({
			date: r.d,
			employee: r.name,
			week: r.week,
			amount: r.amt,
			note: r.note
		});
	}

	// Aggregate Salaries & Wages — 18k per week → Assets sheet
	const weeklyTotals = [
		{ d:'2026-03-21', desc:'Salaries & Wages — Week 1 (16/03 – 22/03)', amt:18000 },
		{ d:'2026-03-28', desc:'Salaries & Wages — Week 2 (23/03 – 29/03)', amt:18000 },
	];
	for (const w of weeklyTotals) {
		accountingData.assets.push({
			date: w.d,
			name: w.desc,
			category: 'Salaries & Wages',
			value: w.amt,
			note: ''
		});
	}
}

function saveAccountingDataToStorage() {
	localStorage.setItem('ww_accounting_data_v2', JSON.stringify(accountingData));
	syncToServer('ww_accounting_data_v2', accountingData);
	try {
		if (!window.__wwAcctChannel) window.__wwAcctChannel = new BroadcastChannel('ww_accounting_sync');
		window.__wwAcctChannel.postMessage({ type: 'accounting_updated' });
	} catch (_e) { /* fallback to storage event */ }
}

function initAccountingPage() {
	if (document.body.getAttribute('data-page') !== 'accounting') {
		return;
	}

	loadAccountingDataFromStorage();
	const refreshAccountingFromServer = async () => {
		try {
			const updated = await loadFromServer('ww_accounting_data_v2');
			if (updated) {
				loadAccountingDataFromStorage();
				renderAccountingPage();
			}
		} catch (_e) { /* keep local data when offline */ }
	};
	const todayStr = getTodayDateStr();

	/* ---- Modal system ---- */
	const ACC_MODAL_CONFIGS = {
		ledger: {
			title: 'Add Ledger Entry',
			fields: [
				{ id: 'date', label: 'Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'desc', label: 'Description', type: 'text', required: true, placeholder: 'e.g. Cash Sale - Customer' },
				{ id: 'account', label: 'Account', type: 'text', required: true, placeholder: 'e.g. Sales Revenue' },
				{ id: 'type', label: 'Type', type: 'select', options: ['asset', 'liability', 'equity', 'revenue', 'expense'], required: true },
				{ id: 'debit', label: 'Debit (GH₵)', type: 'number', min: '0', step: '0.01' },
				{ id: 'credit', label: 'Credit (GH₵)', type: 'number', min: '0', step: '0.01' },
			],
		},
		cashbook: {
			title: 'Add Cashbook Entry',
			fields: [
				{ id: 'date', label: 'Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'desc', label: 'Description', type: 'text', required: true, placeholder: 'e.g. Fuel, Packaging, Plumbing' },
				{ id: 'amount', label: 'Amount (GH₵)', type: 'number', min: '0', step: '0.01', required: true },
			],
		},
		account: {
			title: 'Add Account',
			fields: [
				{ id: 'category', label: 'Category', type: 'select', options: ['Assets', 'Liabilities', 'Equity', 'Revenue', 'Expenses'], required: true },
				{ id: 'name', label: 'Account Name', type: 'text', required: true, placeholder: 'e.g. Bank, Inventory' },
				{ id: 'value', label: 'Balance (GH₵)', type: 'number', min: '0', step: '0.01', required: true },
			],
		},
		currency: {
			title: 'Add Currency',
			fields: [
				{ id: 'code', label: 'Currency Code', type: 'text', required: true, placeholder: 'e.g. USD' },
				{ id: 'name', label: 'Currency Name', type: 'text', required: true, placeholder: 'e.g. US Dollar' },
				{ id: 'rate', label: 'Rate to GH₵', type: 'number', min: '0', step: '0.01', required: true, placeholder: '1 unit = ? GH₵' },
			],
		},
		salary: {
			title: 'Add Salary',
			fields: [
				{ id: 'date', label: 'Date Paid', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'employee', label: 'Employee Name', type: 'text', required: true, placeholder: 'e.g. Ernest Boateng' },
				{ id: 'month', label: 'Month', type: 'month', required: true, defaultValue: todayStr.slice(0, 7) },
				{ id: 'amount', label: 'Amount (GH₵)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'note1', label: 'Note 1', type: 'text', placeholder: 'e.g. Deductions' },
				{ id: 'note2', label: 'Note 2', type: 'text', placeholder: '' },
				{ id: 'note3', label: 'Note 3', type: 'text', placeholder: '' },
				{ id: 'note4', label: 'Note 4', type: 'text', placeholder: '' },
				{ id: 'note5', label: 'Note 5', type: 'text', placeholder: '' },
			],
		},
		'asset-item': {
			title: 'Add Asset',
			fields: [
				{ id: 'date', label: 'Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'name', label: 'Asset Name', type: 'text', required: true, placeholder: 'e.g. Salaries & Wages - Week 1' },
				{ id: 'category', label: 'Category', type: 'select', options: ['Salaries & Wages', 'Equipment', 'Vehicles', 'Property', 'Inventory', 'Furniture', 'Other'], required: true },
				{ id: 'value', label: 'Value (GH₵)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'note', label: 'Notes', type: 'text', placeholder: 'e.g. Week 1 payroll' },
			],
		},
	};

	/* Helper: get Monday of the week for a given date string */
	function getWeekStart(dateStr) {
		const d = new Date(dateStr + 'T00:00:00');
		const day = d.getDay();
		const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
		d.setDate(diff);
		return d.toISOString().slice(0, 10);
	}
	function getWeekEnd(startStr) {
		const d = new Date(startStr + 'T00:00:00');
		d.setDate(d.getDate() + 6);
		return d.toISOString().slice(0, 10);
	}
	function weekLabel(startStr) {
		const s = new Date(startStr + 'T00:00:00');
		const e = new Date(startStr + 'T00:00:00');
		e.setDate(e.getDate() + 6);
		const fmt = (d) => d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
		return `${fmt(s)} – ${fmt(e)}, ${s.getFullYear()}`;
	}
	function salaryMonthFromWeekStart(startStr) {
		if (!startStr) return null;
		return getWeekEnd(startStr).slice(0, 7);
	}
	function isMarchWeeklyWindow(startStr) {
		return !!startStr && String(startStr) >= '2026-03-01' && String(startStr) < '2026-03-30';
	}
	/* Group key: use week (YYYY-MM-DD) for old weekly entries, month (YYYY-MM) for new monthly entries */
	function getSalaryGroup(s) {
		if (s.week && isMarchWeeklyWindow(s.week)) return s.week; // keep March weeks only up to 29 Mar
		if (s.month) return s.month;       // monthly entry
		if (s.week) return salaryMonthFromWeekStart(s.week) || String(s.week).slice(0, 7); // e.g. 30 Mar week => April
		if (s.date) return s.date.slice(0, 7); // fallback
		return null;
	}
	/* Label a group key — 10-char key = week, 7-char key = month */
	function groupLabel(key) {
		if (!key) return '—';
		return key.length === 10 ? weekLabel(key) : monthLabel(key);
	}
	function monthLabel(m) {
		if (!m) return '—';
		const [yr, mo] = m.split('-');
		const d = new Date(Number(yr), Number(mo) - 1, 1);
		return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
	}
	function accountingDateLabel(dateStr) {
		if (!dateStr) return 'Unknown date';
		try {
			const d = new Date(dateStr + 'T00:00:00');
			if (Number.isNaN(d.getTime())) return dateStr;
			return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
		} catch (_e) {
			return dateStr;
		}
	}

	let currentSalaryMonth = null;
	let currentSalaryEmployee = '__all_workers__';
	let currentExpensePeriod = null;
	const ACCOUNTING_EXPENSE_PERIOD_MIN_MONTH = '2026-03';
	let taxRecords = [];
	let taxEditingId = null;
	const EXPENSE_BREAKDOWN_ORDER = ['Salaries', 'Raw Materials', 'Electricity', 'Water Supply', 'Maintenance', 'Supplies', 'Other'];
	const EXPENSE_BREAKDOWN_COLORS = ['#0077b6', '#22c55e', '#f59e0b', '#0ea5e9', '#ef4444', '#8b5cf6', '#64748b', '#14b8a6', '#f97316', '#334155'];
	const toTitleCase = (value) => String(value || '').trim().toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
	function normalizeExpenseCategory(rawCategory) {
		const raw = String(rawCategory || '').trim();
		if (!raw) return 'Other';
		const lower = raw.toLowerCase();
		if (lower.includes('salary') || lower.includes('wage') || lower.includes('payroll')) return 'Salaries';
		if (lower.includes('raw material') || lower.includes('material') || lower.includes('packaging')) return 'Raw Materials';
		if (lower.includes('electric') || lower.includes('power') || lower.includes('ecg')) return 'Electricity';
		if (lower.includes('water')) return 'Water Supply';
		if (lower.includes('maint') || lower.includes('repair') || lower.includes('servic')) return 'Maintenance';
		if (lower.includes('supply') || lower.includes('office')) return 'Supplies';
		if (lower === 'production') return 'Raw Materials';
		return toTitleCase(raw);
	}
	const ledgerCollapseStorageKey = 'ww_accounting_ledger_months_collapsed';
	const loadCollapsedLedgerMonths = () => {
		try {
			const stored = JSON.parse(localStorage.getItem(ledgerCollapseStorageKey) || '[]');
			return new Set(Array.isArray(stored) ? stored : []);
		} catch (_e) {
			return new Set();
		}
	};
	const saveCollapsedLedgerMonths = (set) => {
		try {
			localStorage.setItem(ledgerCollapseStorageKey, JSON.stringify([...set]));
		} catch (_e) { /* ignore */ }
	};
	let collapsedLedgerMonths = loadCollapsedLedgerMonths();
	const cashbookCollapseStorageKey = 'ww_accounting_cashbook_months_collapsed';
	const loadCollapsedCashbookMonths = () => {
		try {
			const stored = JSON.parse(localStorage.getItem(cashbookCollapseStorageKey) || '[]');
			return new Set(Array.isArray(stored) ? stored : []);
		} catch (_e) {
			return new Set();
		}
	};
	const saveCollapsedCashbookMonths = (set) => {
		try {
			localStorage.setItem(cashbookCollapseStorageKey, JSON.stringify([...set]));
		} catch (_e) { /* ignore */ }
	};
	let collapsedCashbookMonths = loadCollapsedCashbookMonths();

	const CURRENCY_ICONS = { USD: 'fa-solid fa-dollar-sign', GBP: 'fa-solid fa-sterling-sign', EUR: 'fa-solid fa-euro-sign' };

	const taxModal = document.getElementById('tax-record-modal');
	const taxModalTitle = document.getElementById('tax-modal-title');
	const taxInputType = document.getElementById('tax-input-type');
	const taxInputPeriod = document.getElementById('tax-input-period');
	const taxInputAmount = document.getElementById('tax-input-amount');
	const taxInputDueDate = document.getElementById('tax-input-duedate');
	const taxPaidDateGroup = document.getElementById('tax-paiddate-group');
	const taxInputPaidDate = document.getElementById('tax-input-paiddate');
	const taxSummaryTotalDue = document.getElementById('tax-summary-total-due');
	const taxSummaryOverdue = document.getElementById('tax-summary-overdue');
	const taxSummaryPaidMonth = document.getElementById('tax-summary-paid-month');

	const taxStatusClass = (status) => {
		if (status === 'Paid') return 'tax-status tax-status-paid';
		if (status === 'Overdue') return 'tax-status tax-status-overdue';
		return 'tax-status tax-status-pending';
	};

	const taxDateLabel = (value) => {
		const text = String(value || '').trim();
		if (!text) return '—';
		const date = new Date(text);
		if (Number.isNaN(date.getTime())) return text;
		return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
	};

	const taxParseDateOnly = (value) => {
		const text = String(value || '').trim();
		if (!text) return null;
		const date = new Date(text + 'T00:00:00');
		return Number.isNaN(date.getTime()) ? null : date;
	};

	const taxRenderSummary = () => {
		if (!taxSummaryTotalDue || !taxSummaryOverdue || !taxSummaryPaidMonth) return;
		const now = new Date();
		const nowMonth = now.getMonth();
		const nowYear = now.getFullYear();
		let totalDue = 0;
		let overdueCount = 0;
		let paidThisMonth = 0;

		taxRecords.forEach((record) => {
			const amount = Number(record && record.amount || 0);
			const status = String(record && record.status || 'Pending');
			if ((status === 'Pending' || status === 'Overdue') && Number.isFinite(amount)) {
				totalDue += amount;
			}
			if (status === 'Overdue') overdueCount += 1;
			const paidDate = taxParseDateOnly(record && record.paidDate);
			if (paidDate && paidDate.getMonth() === nowMonth && paidDate.getFullYear() === nowYear && Number.isFinite(amount)) {
				paidThisMonth += amount;
			}
		});

		taxSummaryTotalDue.textContent = formatCurrency(totalDue);
		taxSummaryOverdue.textContent = String(overdueCount);
		taxSummaryPaidMonth.textContent = formatCurrency(paidThisMonth);
	};

	const taxCloseModal = () => {
		if (taxModal) taxModal.style.display = 'none';
		taxEditingId = null;
		if (taxModalTitle) taxModalTitle.textContent = 'Record Tax Payment';
		if (taxInputType) { taxInputType.disabled = false; taxInputType.value = 'VAT'; }
		if (taxInputPeriod) { taxInputPeriod.disabled = false; taxInputPeriod.value = ''; }
		if (taxInputAmount) { taxInputAmount.disabled = false; taxInputAmount.value = ''; }
		if (taxInputDueDate) { taxInputDueDate.disabled = false; taxInputDueDate.value = ''; }
		if (taxInputPaidDate) taxInputPaidDate.value = '';
		if (taxPaidDateGroup) taxPaidDateGroup.style.display = 'none';
	};

	const taxOpenCreateModal = () => {
		taxEditingId = null;
		if (taxModalTitle) taxModalTitle.textContent = 'Record Tax Payment';
		if (taxPaidDateGroup) taxPaidDateGroup.style.display = 'none';
		if (taxInputType) { taxInputType.disabled = false; taxInputType.value = 'VAT'; }
		if (taxInputPeriod) { taxInputPeriod.disabled = false; taxInputPeriod.value = ''; }
		if (taxInputAmount) { taxInputAmount.disabled = false; taxInputAmount.value = ''; }
		if (taxInputDueDate) { taxInputDueDate.disabled = false; taxInputDueDate.value = ''; }
		if (taxInputPaidDate) taxInputPaidDate.value = '';
		if (taxModal) taxModal.style.display = 'flex';
	};

	const taxOpenMarkPaidModal = (taxId) => {
		const record = taxRecords.find((r) => String(r.taxId || '') === String(taxId || ''));
		if (!record) return;
		taxEditingId = record.taxId;
		if (taxModalTitle) taxModalTitle.textContent = `Mark ${record.taxId} as Paid`;
		if (taxInputType) { taxInputType.disabled = true; taxInputType.value = record.type || 'Other'; }
		if (taxInputPeriod) { taxInputPeriod.disabled = true; taxInputPeriod.value = record.period || ''; }
		if (taxInputAmount) { taxInputAmount.disabled = true; taxInputAmount.value = Number(record.amount || 0); }
		if (taxInputDueDate) {
			taxInputDueDate.disabled = true;
			taxInputDueDate.value = String(record.dueDate || '').slice(0, 10);
		}
		if (taxPaidDateGroup) taxPaidDateGroup.style.display = 'block';
		if (taxInputPaidDate) taxInputPaidDate.value = new Date().toISOString().slice(0, 10);
		if (taxModal) taxModal.style.display = 'flex';
	};

	const taxRenderTable = () => {
		const tbody = document.getElementById('tax-records-tbody');
		const emptyState = document.getElementById('tax-empty-state');
		if (!tbody || !emptyState) return;
		taxRenderSummary();
		if (!taxRecords.length) {
			tbody.innerHTML = '';
			emptyState.style.display = 'block';
			return;
		}
		emptyState.style.display = 'none';
		tbody.innerHTML = taxRecords.map((record) => {
			const markPaidBtn = record.status === 'Paid'
				? ''
				: `<button type="button" class="tax-mark-paid-btn" data-tax-action="mark-paid" data-tax-id="${escapeHtml(record.taxId || '')}">Mark Paid</button>`;
			return `
				<tr>
					<td data-label="Tax ID">${escapeHtml(record.taxId || '')}</td>
					<td data-label="Type">${escapeHtml(record.type || '')}</td>
					<td data-label="Period">${escapeHtml(record.period || '')}</td>
					<td data-label="Amount">${formatCurrency(Number(record.amount || 0))}</td>
					<td data-label="Due Date">${escapeHtml(taxDateLabel(record.dueDate))}</td>
					<td data-label="Paid Date">${escapeHtml(taxDateLabel(record.paidDate))}</td>
					<td data-label="Status"><span class="${taxStatusClass(record.status)}">${escapeHtml(record.status || 'Pending')}</span></td>
					<td data-label="Actions">${markPaidBtn}</td>
				</tr>
			`;
		}).join('');
	};

	const taxLoadRecords = async () => {
		try {
			const res = await fetch(API_BASE + '/api/tax-records', { credentials: 'include', cache: 'no-store' });
			if (!res.ok) throw new Error('Failed to load tax records');
			const payload = await res.json();
			taxRecords = Array.isArray(payload.records) ? payload.records : [];
			taxRenderTable();
		} catch (_error) {
			taxRecords = [];
			taxRenderTable();
		}
	};

	const taxSubmitRecord = async () => {
		const submitBtn = document.getElementById('tax-submit-btn');
		if (submitBtn) {
			submitBtn.disabled = true;
			submitBtn.textContent = 'Saving...';
		}
		try {
			if (taxEditingId) {
				const paidDate = String(taxInputPaidDate && taxInputPaidDate.value || '').trim();
				if (!paidDate) {
					alert('Please select a paid date.');
					return;
				}
				const res = await fetch(API_BASE + '/api/tax-records/' + encodeURIComponent(taxEditingId), {
					method: 'PATCH',
					credentials: 'include',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ paidDate }),
				});
				if (!res.ok) throw new Error('Could not update tax record');
			} else {
				const type = String(taxInputType && taxInputType.value || '').trim();
				const period = String(taxInputPeriod && taxInputPeriod.value || '').trim();
				const amount = Number(taxInputAmount && taxInputAmount.value || 0);
				const dueDate = String(taxInputDueDate && taxInputDueDate.value || '').trim();
				if (!type || !period || !dueDate || !(amount > 0)) {
					alert('Please fill Type, Period, Amount, and Due Date.');
					return;
				}
				const res = await fetch(API_BASE + '/api/tax-records', {
					method: 'POST',
					credentials: 'include',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ type, period, amount, dueDate }),
				});
				if (!res.ok) throw new Error('Could not create tax record');
			}
			taxCloseModal();
			await taxLoadRecords();
		} catch (_error) {
			alert('Could not save tax record.');
		} finally {
			if (submitBtn) {
				submitBtn.disabled = false;
				submitBtn.textContent = 'Save';
			}
		}
	};

	const addModal = document.getElementById('acc-add-modal');
	const modalTitle = document.getElementById('acc-modal-title');
	const modalFieldsEl = document.getElementById('acc-modal-fields');
	const modalForm = document.getElementById('acc-add-form');
	let currentEntity = null;
	let editingAccIdx = -1;
	const accDraftStorageKey = (entity) => `ww_accounting_modal_draft_${entity}`;

	const clearModalValidation = () => {
		if (!modalFieldsEl) return;
		modalFieldsEl.querySelectorAll('.inv-modal-field').forEach((field) => field.classList.remove('has-error'));
		modalFieldsEl.querySelectorAll('.inv-modal-error').forEach((msg) => { msg.textContent = ''; });
		const summary = modalFieldsEl.querySelector('#acc-modal-error-summary');
		if (summary) summary.textContent = '';
	};

	const setFieldValidationError = (fieldId, message) => {
		const input = document.getElementById(`acc-field-${fieldId}`);
		if (!input) return;
		const fieldWrap = input.closest('.inv-modal-field');
		if (fieldWrap) fieldWrap.classList.add('has-error');
		const msgEl = document.getElementById(`acc-err-${fieldId}`);
		if (msgEl) msgEl.textContent = message;
	};

	const validateModalRequiredFields = (options) => {
		const opts = options || {};
		const focusFirst = opts.focusFirst !== false;
		const showSummary = opts.showSummary !== false;
		const config = ACC_MODAL_CONFIGS[currentEntity];
		if (!config) return true;
		clearModalValidation();
		const missing = [];
		for (const field of config.fields) {
			if (!field.required) continue;
			const el = document.getElementById(`acc-field-${field.id}`);
			if (!el || el.disabled) continue;
			const value = String(el.value || '').trim();
			if (value) continue;
			missing.push(field);
			setFieldValidationError(field.id, `${field.label} is required.`);
		}
		if (!missing.length) return true;
		const summary = modalFieldsEl ? modalFieldsEl.querySelector('#acc-modal-error-summary') : null;
		if (summary && showSummary) summary.textContent = 'Please fill the highlighted required fields.';
		if (focusFirst) {
			const firstMissing = document.getElementById(`acc-field-${missing[0].id}`);
			if (firstMissing) firstMissing.focus();
		}
		return false;
	};

	const saveModalDraft = (entity) => {
		if (!entity || editingAccIdx >= 0) return;
		const config = ACC_MODAL_CONFIGS[entity];
		if (!config) return;
		const values = {};
		config.fields.forEach((field) => {
			const el = document.getElementById(`acc-field-${field.id}`);
			if (!el || el.disabled) return;
			values[field.id] = el.value;
		});
		try {
			localStorage.setItem(accDraftStorageKey(entity), JSON.stringify({ values, ts: Date.now() }));
		} catch (_e) { /* ignore */ }
	};

	const clearModalDraft = (entity) => {
		if (!entity) return;
		try { localStorage.removeItem(accDraftStorageKey(entity)); } catch (_e) { /* ignore */ }
	};

	const restoreModalDraft = (entity) => {
		if (!entity || editingAccIdx >= 0) return;
		try {
			const raw = localStorage.getItem(accDraftStorageKey(entity));
			if (!raw) return;
			const parsed = JSON.parse(raw);
			const values = parsed && parsed.values ? parsed.values : null;
			if (!values || typeof values !== 'object') return;
			Object.keys(values).forEach((fieldId) => {
				const el = document.getElementById(`acc-field-${fieldId}`);
				if (!el || el.disabled) return;
				if (!String(el.value || '').trim() && values[fieldId] !== undefined && values[fieldId] !== null) {
					el.value = String(values[fieldId]);
				}
			});
		} catch (_e) { /* ignore */ }
	};

	const getModalDraft = (entity) => {
		if (!entity) return null;
		try {
			const raw = localStorage.getItem(accDraftStorageKey(entity));
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			const values = parsed && parsed.values ? parsed.values : null;
			if (!values || typeof values !== 'object') return null;
			const hasAnyValue = Object.values(values).some((v) => String(v || '').trim() !== '');
			return hasAnyValue ? values : null;
		} catch (_e) {
			return null;
		}
	};

	const bindModalLiveHandlers = () => {
		if (!modalFieldsEl) return;
		const controls = modalFieldsEl.querySelectorAll('input, select, textarea');
		controls.forEach((ctrl) => {
			const syncState = () => {
				saveModalDraft(currentEntity);
				validateModalRequiredFields({ focusFirst: false, showSummary: false });
			};
			ctrl.addEventListener('input', syncState);
			ctrl.addEventListener('change', syncState);
			ctrl.addEventListener('blur', () => {
				validateModalRequiredFields({ focusFirst: false, showSummary: false });
			});
		});
	};

	const closeModal = (opts = {}) => {
		const savedEntity = currentEntity;
		const wasAdding = editingAccIdx < 0;
		const shouldSaveDraft = opts.saveDraft !== false;
		if (wasAdding && savedEntity && shouldSaveDraft) saveModalDraft(savedEntity);
		if (addModal) addModal.style.display = 'none';
		if (modalForm) modalForm.reset();
		clearModalValidation();
		currentEntity = null;
		editingAccIdx = -1;
		if (wasAdding && savedEntity) renderAccountingPage();
	};
	window.addEventListener('beforeunload', () => { if (editingAccIdx < 0 && currentEntity) saveModalDraft(currentEntity); });

	/* ── Salary slip breakdown editor (shared by Add + Edit) ───────── */
	const SLIP_SECTIONS = [
		{ key: 'earnings', title: 'Earnings', sign: 1 },
		{ key: 'allowances', title: 'Allowances', sign: 1 },
		{ key: 'deductions', title: 'Deductions', sign: -1 },
	];
	let modalSlipMeta = null; // { id, position, dept, period } for the record open in the modal

	/* A blank breakdown with the standard line items pre-listed. */
	const buildDefaultSlipData = () => ({
		id: '', position: '', dept: '', period: '',
		earnings: [
			{ desc: 'Basic Salary', amt: 0, rate: '\u2014' },
			{ desc: 'Overtime Pay', amt: 0, rate: '\u2014' },
		],
		allowances: [
			{ desc: 'Transport Allowance', amt: 0, rate: '\u2014' },
			{ desc: 'Housing Allowance', amt: 0, rate: '\u2014' },
			{ desc: 'Professional Allowance', amt: 0, rate: '\u2014' },
		],
		deductions: [
			{ desc: 'SSNIT Contribution', amt: 0, rate: '\u2014' },
			{ desc: 'Loan Repayment', amt: 0, rate: '\u2014' },
		],
		gross: 0, totalAllowances: 0, totalDeductions: 0, net: 0,
	});

	/* Recalculate the modal's Amount field (net pay) from the breakdown rows. */
	const recomputeModalNet = () => {
		if (!modalFieldsEl) return;
		let net = 0;
		let anyValue = false;
		SLIP_SECTIONS.forEach(({ key, sign }) => {
			modalFieldsEl.querySelectorAll(`input[data-slip-section="${key}"][data-slip-amt]`).forEach((inp) => {
				const v = Number(inp.value) || 0;
				if (v) anyValue = true;
				net += sign * v;
			});
		});
		// Only take over the Amount field once a breakdown value exists, so the
		// quick "just type an amount" path still works when no breakdown is entered.
		const amtEl = document.getElementById('acc-field-amount');
		if (amtEl && anyValue) amtEl.value = net < 0 ? 0 : net;
	};

	/* Build a single editable breakdown row (description + amount + remove). */
	const makeSlipRow = (key, desc, amt, rate) => {
		const wrap = document.createElement('div');
		wrap.className = 'slip-edit-row';
		wrap.dataset.slipRow = key;
		wrap.innerHTML = `
			<input class="slip-edit-desc" type="text" data-slip-section="${key}" data-slip-desc placeholder="Description" value="${escapeHtml(desc || '')}">
			<input class="slip-edit-amt" type="number" step="0.01" min="0" data-slip-section="${key}" data-slip-amt placeholder="0.00" value="${Number(amt) || 0}">
			<input type="hidden" data-slip-section="${key}" data-slip-rate value="${escapeHtml(rate || '\u2014')}">
			<button type="button" class="slip-edit-remove" title="Remove row" aria-label="Remove row"><i class="fa-solid fa-xmark"></i></button>
		`;
		wrap.querySelector('.slip-edit-amt').addEventListener('input', recomputeModalNet);
		wrap.querySelector('.slip-edit-remove').addEventListener('click', () => { wrap.remove(); recomputeModalNet(); });
		return wrap;
	};

	/* Append the editable breakdown section to the modal (uses default template when none given). */
	const injectSalarySlipFields = (slipData) => {
		if (!modalFieldsEl) return;
		const sd = slipData || buildDefaultSlipData();
		modalSlipMeta = { id: sd.id || '', position: sd.position || '', dept: sd.dept || '', period: sd.period || '' };
		const section = document.createElement('div');
		section.className = 'slip-edit-section';
		section.innerHTML = `<p class="slip-edit-heading">Salary Slip Breakdown</p>`;
		SLIP_SECTIONS.forEach(({ key, title }) => {
			const group = document.createElement('div');
			group.className = 'slip-edit-group';
			group.innerHTML = `<div class="slip-edit-group-head"><p class="slip-edit-title">${title}</p><button type="button" class="slip-edit-add"><i class="fa-solid fa-plus"></i> Add row</button></div>`;
			const rowsHost = document.createElement('div');
			rowsHost.className = 'slip-edit-rows';
			(Array.isArray(sd[key]) ? sd[key] : []).forEach((it) => rowsHost.appendChild(makeSlipRow(key, it.desc, it.amt, it.rate)));
			group.appendChild(rowsHost);
			group.querySelector('.slip-edit-add').addEventListener('click', () => {
				rowsHost.appendChild(makeSlipRow(key, '', 0, '\u2014'));
				recomputeModalNet();
			});
			section.appendChild(group);
		});
		modalFieldsEl.appendChild(section);
		recomputeModalNet();
	};

	/* Read the breakdown rows back into a slipData object with recomputed totals. */
	const collectSlipDataFromModal = () => {
		if (!modalFieldsEl || !modalFieldsEl.querySelector('[data-slip-row]')) return null;
		const meta = modalSlipMeta || { id: '', position: '', dept: '', period: '' };
		const sd = { ...meta, earnings: [], allowances: [], deductions: [] };
		modalFieldsEl.querySelectorAll('[data-slip-row]').forEach((row) => {
			const key = row.dataset.slipRow;
			const desc = (row.querySelector('[data-slip-desc]')?.value || '').trim();
			const amt = Number(row.querySelector('[data-slip-amt]')?.value) || 0;
			const rate = (row.querySelector('[data-slip-rate]')?.value || '\u2014').trim() || '\u2014';
			if (!desc && !amt) return; // skip blank rows
			if (sd[key]) sd[key].push({ desc: desc || 'Item', amt, rate });
		});
		const sum = (arr) => arr.reduce((s, it) => s + (Number(it.amt) || 0), 0);
		sd.gross = sum(sd.earnings);
		sd.totalAllowances = sum(sd.allowances);
		sd.totalDeductions = sum(sd.deductions);
		sd.net = Math.max(0, sd.gross + sd.totalAllowances - sd.totalDeductions);
		return sd;
	};

	/* Build the Notes array from a slip breakdown so the table/notes stay in sync after edits. */
	const buildSalaryNotesFromSlip = (sd, extraNotes) => {
		const fmt2 = (n) => Number(n).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		const autoNotes = [
			sd.dept ? `Dept: ${sd.dept}` : null,
			sd.position ? `Position: ${sd.position}` : null,
			sd.id ? `ID: ${sd.id}` : null,
			`Gross: GH₵ ${fmt2(sd.gross)}`,
			sd.totalAllowances > 0 ? `Allowances: GH₵ ${fmt2(sd.totalAllowances)}` : null,
			`Deductions: GH₵ ${fmt2(sd.totalDeductions)}`,
		].filter(Boolean);
		const userExtra = (extraNotes || []).filter((n) => n && !/^(Dept:|Position:|ID:|Gross:|Allowances:|Deductions:)/.test(n));
		return [...autoNotes, ...userExtra];
	};

	const openModal = (entity, editIdx, resumeDraft = false) => {
		const config = ACC_MODAL_CONFIGS[entity];
		if (!config || !addModal) return;
		currentEntity = entity;
		editingAccIdx = typeof editIdx === 'number' ? editIdx : -1;
		if (modalTitle) modalTitle.textContent = editingAccIdx >= 0 ? config.title.replace('Add', 'Edit') : config.title;
		if (modalFieldsEl) {
			modalFieldsEl.innerHTML = `<p class="inv-modal-summary-error" id="acc-modal-error-summary" aria-live="polite"></p>` + config.fields.map((f) => {
				if (f.type === 'select') {
					return `<div class="inv-modal-field"><label for="acc-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><select id="acc-field-${f.id}" name="${f.id}" ${f.required ? 'required' : ''}>${f.options.map((o) => `<option value="${o}">${o.charAt(0).toUpperCase() + o.slice(1)}</option>`).join('')}</select><p class="inv-modal-error" id="acc-err-${f.id}" aria-live="polite"></p></div>`;
				}
				if (f.type === 'textarea') {
					return `<div class="inv-modal-field"><label for="acc-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><textarea id="acc-field-${f.id}" name="${f.id}" rows="${f.rows || 5}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} style="width:100%;resize:vertical;"></textarea><p class="inv-modal-error" id="acc-err-${f.id}" aria-live="polite"></p></div>`;
				}
				return `<div class="inv-modal-field"><label for="acc-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><input id="acc-field-${f.id}" type="${f.type}" name="${f.id}" ${f.required ? 'required' : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} ${f.defaultValue ? `value="${f.defaultValue}"` : ''}><p class="inv-modal-error" id="acc-err-${f.id}" aria-live="polite"></p></div>`;
			}).join('');
		}
		/* Pre-fill for editing */
		if (editingAccIdx >= 0) {
			let row;
			if (entity === 'ledger') row = accountingData.ledger[editingAccIdx];
			else if (entity === 'cashbook') row = accountingData.cashbook[editingAccIdx];
			else if (entity === 'account') row = accountingData.summary[editingAccIdx];
			else if (entity === 'currency') row = accountingData.currencies[editingAccIdx];
			else if (entity === 'salary') row = accountingData.salaries[editingAccIdx];
			else if (entity === 'asset-item') row = accountingData.assets[editingAccIdx];
			if (row) {
				const setVal = (id, v) => { const el = document.getElementById('acc-field-' + id); if (el && v !== undefined) el.value = v; };
				Object.keys(row).forEach((k) => setVal(k, row[k]));
				if (entity === 'salary' && !row.month && row.week) {
					setVal('month', String(row.week).slice(0, 7));
				}
				/* Restore individual note fields from notes array */
				if (Array.isArray(row.notes)) {
					row.notes.forEach((n, i) => setVal('note' + (i + 1), n));
				}
			}
		}
		/* Salary slip breakdown — editable for both Add and Edit. */
		if (entity === 'salary' && modalFieldsEl) {
			const rec = editingAccIdx >= 0 ? accountingData.salaries[editingAccIdx] : null;
			let seed = rec && rec.slipData ? rec.slipData : null;
			if (!seed && rec && Number(rec.amount) > 0) {
				// Existing record without a breakdown: seed Basic Salary with its current total.
				seed = buildDefaultSlipData();
				seed.earnings[0].amt = Number(rec.amount) || 0;
			}
			injectSalarySlipFields(seed);
		}
		addModal.style.display = 'flex';
		const firstInput = modalFieldsEl && modalFieldsEl.querySelector('input, select');
		if (resumeDraft) restoreModalDraft(entity);
		if (firstInput) firstInput.focus();
		bindModalLiveHandlers();
		validateModalRequiredFields({ focusFirst: false, showSummary: false });
	};

	document.getElementById('acc-modal-close')?.addEventListener('click', closeModal);
	document.getElementById('acc-modal-cancel')?.addEventListener('click', closeModal);
	addModal?.addEventListener('click', (e) => { if (e.target === addModal) closeModal(); });
	document.getElementById('tax-add-btn')?.addEventListener('click', taxOpenCreateModal);
	document.getElementById('tax-modal-close')?.addEventListener('click', taxCloseModal);
	document.getElementById('tax-cancel-btn')?.addEventListener('click', taxCloseModal);
	document.getElementById('tax-submit-btn')?.addEventListener('click', taxSubmitRecord);
	taxModal?.addEventListener('click', (e) => { if (e.target === taxModal) taxCloseModal(); });

	const getValue = (id) => { const el = document.getElementById(`acc-field-${id}`); return el ? el.value.trim() : ''; };
	const getNum = (id) => { const v = Number(getValue(id)); return Number.isFinite(v) && v >= 0 ? v : 0; };

	if (modalForm && !modalForm.dataset.bound) {
		modalForm.dataset.bound = '1';
		modalForm.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!currentEntity) return;
			if (!validateModalRequiredFields()) return;

			if (currentEntity === 'ledger') {
				const desc = getValue('desc');
				const account = getValue('account');
				if (!desc || !account) return;
				const data = {
					date: getValue('date') || todayStr,
					desc,
					account,
					type: getValue('type') || 'asset',
					debit: getNum('debit'),
					credit: getNum('credit'),
				};
				if (editingAccIdx >= 0 && accountingData.ledger[editingAccIdx]) {
					Object.assign(accountingData.ledger[editingAccIdx], data);
				} else {
					accountingData.ledger.push(data);
				}
			}

			if (currentEntity === 'cashbook') {
				const desc = getValue('desc');
				if (!desc) return;
				const data = {
					date: getValue('date') || todayStr,
					desc,
					amount: getNum('amount'),
				};
				if (editingAccIdx >= 0 && accountingData.cashbook[editingAccIdx]) {
					Object.assign(accountingData.cashbook[editingAccIdx], data);
				} else {
					accountingData.cashbook.push(data);
				}
			}

			if (currentEntity === 'account') {
				const name = getValue('name');
				const category = getValue('category');
				if (!name || !category) return;
				const data = { category, name, value: getNum('value') };
				if (editingAccIdx >= 0 && accountingData.summary[editingAccIdx]) {
					Object.assign(accountingData.summary[editingAccIdx], data);
				} else {
					accountingData.summary.push(data);
				}
			}

			if (currentEntity === 'currency') {
				const code = getValue('code').toUpperCase();
				const name = getValue('name');
				if (!code || !name) return;
				const data = { code, name, rate: getNum('rate') };
				if (editingAccIdx >= 0 && accountingData.currencies[editingAccIdx]) {
					Object.assign(accountingData.currencies[editingAccIdx], data);
				} else {
					accountingData.currencies.push(data);
				}
			}

			if (currentEntity === 'salary') {
				const employee = getValue('employee');
				if (!employee) return;
				const dateVal = getValue('date') || todayStr;
				const monthVal = getValue('month') || String(dateVal).slice(0, 7);
				const weekStart = getWeekStart(dateVal);
				const keepMarchWeekly = monthVal === '2026-03' && isMarchWeeklyWindow(weekStart);
				const userNotes = [getValue('note1'), getValue('note2'), getValue('note3'), getValue('note4'), getValue('note5')].filter(Boolean);

				// Pull the breakdown the user entered/edited; recompute net + notes from it.
				const slipData = collectSlipDataFromModal();
				const hasBreakdown = !!(slipData && (slipData.gross > 0 || slipData.totalAllowances > 0 || slipData.totalDeductions > 0));
				const amount = hasBreakdown ? slipData.net : getNum('amount');
				const notes = hasBreakdown ? buildSalaryNotesFromSlip(slipData, userNotes) : userNotes;

				const data = {
					date: dateVal,
					employee,
					month: monthVal,
					week: keepMarchWeekly ? weekStart : undefined,
					amount,
					notes,
					note: notes.join(' · ') || '',
				};
				if (hasBreakdown) {
					data.slipData = slipData;
					data._fromSlip = true;
				}
				if (editingAccIdx >= 0 && accountingData.salaries[editingAccIdx]) {
					const old = accountingData.salaries[editingAccIdx];
					const li = accountingData.ledger.findIndex(e => e.account === 'Salaries' && e.desc === `Salary — ${old.employee}` && e.date === old.date);
					if (li >= 0) { accountingData.ledger[li].date = data.date; accountingData.ledger[li].desc = `Salary — ${data.employee}`; accountingData.ledger[li].debit = data.amount; }
					Object.assign(accountingData.salaries[editingAccIdx], data);
					if (!keepMarchWeekly) delete accountingData.salaries[editingAccIdx].week;
				} else {
					if (!keepMarchWeekly) delete data.week;
					accountingData.salaries.push(data);
					accountingData.ledger.push({ date: data.date, desc: `Salary — ${data.employee}`, account: 'Salaries', type: 'expense', debit: data.amount, credit: 0 });
				}
				currentSalaryMonth = monthVal;
			}

			if (currentEntity === 'asset-item') {
				const name = getValue('name');
				if (!name) return;
				const data = {
					date: getValue('date') || todayStr,
					name,
					category: getValue('category') || 'Other',
					value: getNum('value'),
					note: getValue('note') || '',
				};
				if (editingAccIdx >= 0 && accountingData.assets[editingAccIdx]) {
					Object.assign(accountingData.assets[editingAccIdx], data);
				} else {
					accountingData.assets.push(data);
				}
			}

			saveAccountingDataToStorage();
			clearModalDraft(currentEntity);
			closeModal({ saveDraft: false });
			renderAccountingPage();
		});
	}

	document.addEventListener('click', (event) => {
		const taxMarkBtn = event.target.closest('[data-tax-action="mark-paid"][data-tax-id]');
		if (taxMarkBtn) {
			event.stopPropagation();
			taxOpenMarkPaidModal(taxMarkBtn.getAttribute('data-tax-id'));
			return;
		}

		const btn = event.target.closest('.acc-add-btn[data-add-entity]');
		if (btn) { openModal(btn.getAttribute('data-add-entity'), undefined, false); return; }
		const resumeDraftBtn = event.target.closest('.acc-resume-draft-btn[data-draft-entity]');
		if (resumeDraftBtn) { event.stopPropagation(); openModal(resumeDraftBtn.getAttribute('data-draft-entity'), undefined, true); return; }
		const clearDraftBtn = event.target.closest('.acc-clear-draft-btn[data-draft-entity]');
		if (clearDraftBtn) {
			event.stopPropagation();
			clearModalDraft(clearDraftBtn.getAttribute('data-draft-entity'));
			renderAccountingPage();
			return;
		}
		const weekPickBtn = event.target.closest('.acc-week-pick-btn[data-month]');
		if (weekPickBtn) {
			event.stopPropagation();
			currentSalaryMonth = weekPickBtn.getAttribute('data-month') || currentSalaryMonth;
			currentSalaryEmployee = '__all_workers__';
			renderAccountingPage();
			return;
		}
		const salaryNameLink = event.target.closest('.salary-name-link[data-salary-employee]');
		if (salaryNameLink) {
			event.stopPropagation();
			currentSalaryMonth = salaryNameLink.getAttribute('data-salary-month') || currentSalaryMonth;
			currentSalaryEmployee = salaryNameLink.getAttribute('data-salary-employee') || '__all_workers__';
			printCurrentSalarySelection();
			return;
		}
		const editBtn = event.target.closest('.acc-edit-btn');
		if (editBtn) {
			event.stopPropagation();
			openModal(editBtn.getAttribute('data-edit-entity'), Number(editBtn.getAttribute('data-edit-idx')));
			return;
		}
		const deleteBtn = event.target.closest('.acc-delete-btn');
		if (deleteBtn) {
			event.stopPropagation();
			const entity = deleteBtn.getAttribute('data-delete-entity');
			const idx = Number(deleteBtn.getAttribute('data-delete-idx'));
			if (!window.confirm('Delete this ' + entity + ' entry? This cannot be undone.')) return;
			let toastMsg = '';
			if (entity === 'ledger') {
				const removed = accountingData.ledger[idx];
				if (removed) moveAppDataDeleteToTrash('accounting', removed, { kind: 'appDataArray', key: 'ww_accounting_data_v2', arrayPath: 'ledger' });
				accountingData.ledger.splice(idx, 1);
				toastMsg = 'Ledger entry deleted.';
			}
			else if (entity === 'cashbook') {
				const removed = accountingData.cashbook[idx];
				if (removed) moveAppDataDeleteToTrash('accounting', removed, { kind: 'appDataArray', key: 'ww_accounting_data_v2', arrayPath: 'cashbook' });
				accountingData.cashbook.splice(idx, 1);
				toastMsg = 'Cashbook entry deleted.';
			}
			else if (entity === 'account') {
				const removed = accountingData.summary[idx];
				if (removed) moveAppDataDeleteToTrash('accounting', removed, { kind: 'appDataArray', key: 'ww_accounting_data_v2', arrayPath: 'summary' });
				accountingData.summary.splice(idx, 1);
				toastMsg = 'Account removed.';
			}
			else if (entity === 'currency') {
				const removed = accountingData.currencies[idx];
				if (removed) moveAppDataDeleteToTrash('accounting', removed, { kind: 'appDataArray', key: 'ww_accounting_data_v2', arrayPath: 'currencies' });
				accountingData.currencies.splice(idx, 1);
				toastMsg = 'Currency removed.';
			}
			else if (entity === 'salary') {
				const sal = accountingData.salaries[idx];
				if (sal) moveAppDataDeleteToTrash('accounting', sal, { kind: 'appDataArray', key: 'ww_accounting_data_v2', arrayPath: 'salaries' });
				if (sal) {
					const li = accountingData.ledger.findIndex(e => e.account === 'Salaries' && e.desc === `Salary — ${sal.employee}` && e.date === sal.date);
					if (li >= 0) accountingData.ledger.splice(li, 1);
				}
				accountingData.salaries.splice(idx, 1);
				toastMsg = `Salary record for ${sal ? sal.employee : 'employee'} deleted.`;
			}
			else if (entity === 'asset-item') {
				const removed = accountingData.assets[idx];
				if (removed) moveAppDataDeleteToTrash('accounting', removed, { kind: 'appDataArray', key: 'ww_accounting_data_v2', arrayPath: 'assets' });
				accountingData.assets.splice(idx, 1);
				toastMsg = `Asset "${removed ? removed.name : 'item'}" deleted.`;
			}
			saveAccountingDataToStorage();
			renderAccountingPage();
			if (toastMsg) setTimeout(() => showDeleteToast(toastMsg), 50);
		}
	});

	function renderAccountingPage() {
		const ledger = accountingData.ledger;
		const cashbook = accountingData.cashbook;
		const manualAccounts = accountingData.summary;
		const currencies = accountingData.currencies;
		const ledgerDraft = getModalDraft('ledger');
		const cashbookDraft = getModalDraft('cashbook');
		const salaryDraft = getModalDraft('salary');
		const assetDraft = getModalDraft('asset-item');

		/* Build account summary: merge manual accounts + auto-computed from ledger */
		const TYPE_TO_CATEGORY = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Revenue', expense: 'Expenses' };
		const categoryOrder = ['Assets', 'Liabilities', 'Equity', 'Revenue', 'Expenses'];
		const accountBalances = {}; /* { "Assets|Bank": value } */

		/* Start with manually added accounts */
		manualAccounts.forEach((a) => {
			const key = a.category + '|' + a.name;
			accountBalances[key] = (accountBalances[key] || 0) + a.value;
		});

		/* Add ledger entries: debits increase assets/expenses, credits increase liabilities/equity/revenue */
		ledger.forEach((entry) => {
			const cat = TYPE_TO_CATEGORY[entry.type];
			if (!cat) return;
			const key = cat + '|' + entry.account;
			if (!accountBalances[key]) accountBalances[key] = 0;
			if (cat === 'Assets' || cat === 'Expenses') {
				accountBalances[key] += (entry.debit || 0) - (entry.credit || 0);
			} else {
				accountBalances[key] += (entry.credit || 0) - (entry.debit || 0);
			}
		});

		const grouped = {};
		categoryOrder.forEach((c) => { grouped[c] = []; });
		Object.keys(accountBalances).forEach((key) => {
			const [cat, name] = key.split('|');
			grouped[cat].push({ name, value: accountBalances[key] });
		});
		const accountSummary = categoryOrder.filter((c) => grouped[c].length > 0).map((c) => {
			const total = grouped[c].reduce((sum, a) => sum + a.value, 0);
			return { category: c, accounts: grouped[c], total };
		});

		const expensePeriods = [...new Set(
			ledger
				.filter((entry) => String(entry.type || '').toLowerCase() === 'expense' && /^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || '')))
				.map((entry) => String(entry.date).slice(0, 7))
				.filter((period) => period >= ACCOUNTING_EXPENSE_PERIOD_MIN_MONTH)
		)].sort();
		if (!currentExpensePeriod) currentExpensePeriod = expensePeriods[expensePeriods.length - 1] || '__all__';
		if (currentExpensePeriod !== '__all__' && !expensePeriods.includes(currentExpensePeriod)) {
			currentExpensePeriod = expensePeriods[expensePeriods.length - 1] || '__all__';
		}

		const filteredExpenseEntries = ledger.filter((entry) => {
			if (String(entry.type || '').toLowerCase() !== 'expense') return false;
			const date = String(entry.date || '').trim();
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
			if (date.slice(0, 7) < ACCOUNTING_EXPENSE_PERIOD_MIN_MONTH) return false;
			if (currentExpensePeriod === '__all__') return true;
			return date.slice(0, 7) === currentExpensePeriod;
		});
		const expenseCategoryTotals = new Map(EXPENSE_BREAKDOWN_ORDER.map((category) => [category, 0]));
		filteredExpenseEntries.forEach((entry) => {
			const category = normalizeExpenseCategory(entry.account || entry.desc || 'Other');
			const amount = Number(entry.debit || 0) - Number(entry.credit || 0);
			if (!Number.isFinite(amount) || Math.abs(amount) < 0.005) return;
			expenseCategoryTotals.set(category, (expenseCategoryTotals.get(category) || 0) + amount);
		});
		const expenseBreakdownRows = [...expenseCategoryTotals.entries()]
			.map(([category, amount]) => ({ category, amount }))
			.sort((a, b) => {
				const aIdx = EXPENSE_BREAKDOWN_ORDER.indexOf(a.category);
				const bIdx = EXPENSE_BREAKDOWN_ORDER.indexOf(b.category);
				if (aIdx !== -1 || bIdx !== -1) {
					if (aIdx === -1) return 1;
					if (bIdx === -1) return -1;
					if (aIdx !== bIdx) return aIdx - bIdx;
				}
				return b.amount - a.amount;
			});
		const expenseBreakdownTotal = expenseBreakdownRows.reduce((sum, row) => sum + row.amount, 0);
		expenseBreakdownRows.forEach((row, idx) => {
			row.percent = expenseBreakdownTotal > 0 ? (row.amount / expenseBreakdownTotal) * 100 : 0;
			row.color = EXPENSE_BREAKDOWN_COLORS[idx % EXPENSE_BREAKDOWN_COLORS.length];
		});
		const chartExpenseRows = expenseBreakdownRows.filter((row) => row.amount > 0.004);

		/* Stats — auto-computed from all sheets */
		const totalDebits = ledger.reduce((s, e) => s + (e.debit || 0), 0);
		const totalCredits = ledger.reduce((s, e) => s + (e.credit || 0), 0);
		const cashTotal = cashbook.reduce((s, e) => s + (e.amount || 0), 0);
		const revCat = accountSummary.find((x) => x.category === 'Revenue');
		const expCat = accountSummary.find((x) => x.category === 'Expenses');
		const assCat = accountSummary.find((x) => x.category === 'Assets');
		const liaCat = accountSummary.find((x) => x.category === 'Liabilities');

		// Pull sales revenue from invoices (paid only)
		const allSales = getAllSalesData();
		const salesRevenue = allSales.invoices
			.filter((inv) => inv.status === 'paid')
			.reduce((s, inv) => s + (Number(inv.amount) || 0), 0);
		// Promo bags are free/discounted giveaways — booked as a marketing operating cost (derived, not a manual entry)
		const promoExpense = allSales.invoices
			.filter((inv) => inv.status === 'paid')
			.reduce((s, inv) => {
				const rate = Number(inv.rate || (inv.items && inv.items[0] ? inv.items[0].unitPrice : 0) || 0);
				return s + (Number(inv.promo || 0) * rate);
			}, 0);

		const revenue = (revCat ? revCat.total : 0) + salesRevenue;
		const ledgerExpense = expCat ? expCat.total : 0;
		const expense = ledgerExpense + promoExpense;
		const assetsSheetTotal = accountingData.assets.reduce((s, a) => s + (a.value || 0), 0);
		const assets = (assCat ? assCat.total : 0) + assetsSheetTotal;
		const liabilities = liaCat ? liaCat.total : 0;
		const profitLoss = revenue - expense + assetsSheetTotal;
		const plClass = profitLoss >= 0 ? 'color:#22c55e' : 'color:#ef4444';

		const stats = document.getElementById('acc-stats-row');
		if (stats) {
			stats.innerHTML = `
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-book"></i></div><p class="s-label">Ledger Entries</p><p class="s-value">${ledger.length}</p><p class="s-meta">Dr ${formatCurrency(totalDebits)} · Cr ${formatCurrency(totalCredits)}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-wallet"></i></div><p class="s-label">Cashbook Total</p><p class="s-value">${formatCurrency(cashTotal)}</p><p class="s-meta">${cashbook.length} entries</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-money-bill-trend-up"></i></div><p class="s-label">Revenue</p><p class="s-value">${formatCurrency(revenue)}</p><p class="s-meta">Sales ${formatCurrency(salesRevenue)} · Ledger ${formatCurrency(revCat ? revCat.total : 0)}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-file-invoice-dollar"></i></div><p class="s-label">Expenses</p><p class="s-value">${formatCurrency(expense)}</p><p class="s-meta">Ledger ${formatCurrency(ledgerExpense)} · Promo ${formatCurrency(promoExpense)}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-chart-line"></i></div><p class="s-label">Profit / Loss</p><p class="s-value" style="${plClass}">${formatCurrency(profitLoss)}</p><p class="s-meta">Revenue ${formatCurrency(revenue)} − Expenses ${formatCurrency(expense)}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-scale-balanced"></i></div><p class="s-label">Net Position</p><p class="s-value">${formatCurrency(assets - liabilities)}</p><p class="s-meta">Assets ${formatCurrency(assets)} · Liabilities ${formatCurrency(liabilities)}</p></div>
			`;
		}

		/* General Ledger — grouped by month, then day, with subtotals */
		const ledgerBody = document.getElementById('ledger-tbody');
		if (ledgerBody) {
			const ledgerDraftRow = ledgerDraft ? `<tr class="draft-row"><td>${escapeHtml(ledgerDraft.date || '')}</td><td>${escapeHtml(ledgerDraft.desc || 'Unsaved ledger entry')}</td><td>${escapeHtml(ledgerDraft.account || '')}</td><td><span class="badge badge-orange">Draft</span></td><td>${escapeHtml(ledgerDraft.debit || '')}</td><td>${escapeHtml(ledgerDraft.credit || '')}</td><td><div class="row-actions"><button class="btn-edit acc-resume-draft-btn" data-draft-entity="ledger" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete acc-clear-draft-btn" data-draft-entity="ledger" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td></tr>` : '';
			if (ledger.length === 0) {
				ledgerBody.innerHTML = ledgerDraftRow || '<tr><td colspan="7" style="text-align:center;color:#94a3b8;">No entries yet. Click "Add Entry" to start.</td></tr>';
			} else {
				const byMonth = {};
				ledger.forEach((row, idx) => {
					const monthKey = String(row.date || '').slice(0, 7) || 'Unknown';
					const dateKey = row.date || 'Unknown';
					if (!byMonth[monthKey]) byMonth[monthKey] = {};
					if (!byMonth[monthKey][dateKey]) byMonth[monthKey][dateKey] = [];
					byMonth[monthKey][dateKey].push({ ...row, _idx: idx });
				});
				const sortedMonths = Object.keys(byMonth).sort();
				const newestMonth = sortedMonths[sortedMonths.length - 1] || null;
				collapsedLedgerMonths = new Set([...collapsedLedgerMonths].filter((monthKey) => byMonth[monthKey]));
				if (newestMonth && sortedMonths.length > 1 && !collapsedLedgerMonths.size) {
					sortedMonths.slice(0, -1).forEach((monthKey) => collapsedLedgerMonths.add(monthKey));
					saveCollapsedLedgerMonths(collapsedLedgerMonths);
				}
				let html = '';
				let grandDebit = 0, grandCredit = 0;
				for (const monthKey of sortedMonths) {
					const datesInMonth = byMonth[monthKey];
					const sortedDates = Object.keys(datesInMonth).sort();
					let monthDebit = 0, monthCredit = 0;
					const isCollapsed = collapsedLedgerMonths.has(monthKey);
					html += `<tr class="ledger-month-header"><td colspan="7" style="padding:0;"><button type="button" class="accounting-month-toggle${isCollapsed ? ' is-collapsed' : ''}" data-ledger-month="${escapeHtml(monthKey)}" aria-expanded="${isCollapsed ? 'false' : 'true'}"><span class="accounting-month-toggle-left"><i class="fa-solid fa-chevron-right accounting-month-chevron${isCollapsed ? '' : ' is-open'}"></i><i class="fa-solid fa-calendar-days"></i><span>${escapeHtml(monthLabel(monthKey))}</span></span><span class="accounting-month-toggle-meta">${sortedDates.length} day${sortedDates.length === 1 ? '' : 's'}</span></button></td></tr>`;
					for (const date of sortedDates) {
						const entries = datesInMonth[date];
						let dayDebit = 0, dayCredit = 0;
						const dateLabel = accountingDateLabel(date);
						html += `<tr class="ledger-date-header accounting-month-row${isCollapsed ? ' is-hidden' : ''}" data-ledger-month-row="${escapeHtml(monthKey)}"><td colspan="7" style="background:#f0f4ff;font-weight:700;color:#1e40af;padding:10px 14px 10px 26px;border-top:1px solid #bfdbfe;font-size:0.95rem;"><i class="fa-solid fa-calendar-day" style="margin-right:6px;"></i>${escapeHtml(dateLabel)}</td></tr>`;
						for (const row of entries) {
							const badgeClass = row.type === 'asset' ? 'badge-blue' : row.type === 'liability' ? 'badge-red' : row.type === 'revenue' ? 'badge-green' : row.type === 'expense' ? 'badge-orange' : 'badge-purple';
							dayDebit += row.debit || 0;
							dayCredit += row.credit || 0;
							html += `<tr class="accounting-month-row${isCollapsed ? ' is-hidden' : ''}" data-ledger-month-row="${escapeHtml(monthKey)}"><td>${escapeHtml(row.date || '')}</td><td>${escapeHtml(row.desc || '')}</td><td>${escapeHtml(row.account || '')}</td><td><span class="badge ${badgeClass}">${escapeHtml(row.type || '')}</span></td><td>${row.debit ? formatCurrency(row.debit) : '-'}</td><td>${row.credit ? formatCurrency(row.credit) : '-'}</td><td><div class="row-actions"><button class="btn-edit acc-edit-btn" data-edit-entity="ledger" data-edit-idx="${row._idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete acc-delete-btn" data-delete-entity="ledger" data-delete-idx="${row._idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
						}
						html += `<tr class="ledger-subtotal accounting-month-row${isCollapsed ? ' is-hidden' : ''}" data-ledger-month-row="${escapeHtml(monthKey)}"><td colspan="4" style="text-align:right;font-weight:700;background:#f8fafc;color:#475569;padding:8px 14px;">Subtotal — ${escapeHtml(dateLabel)}</td><td style="font-weight:700;background:#f8fafc;color:#1e40af;">${formatCurrency(dayDebit)}</td><td style="font-weight:700;background:#f8fafc;color:#1e40af;">${formatCurrency(dayCredit)}</td><td style="background:#f8fafc;"></td></tr>`;
						monthDebit += dayDebit;
						monthCredit += dayCredit;
					}
					html += `<tr class="ledger-month-total accounting-month-row${isCollapsed ? ' is-hidden' : ''}" data-ledger-month-row="${escapeHtml(monthKey)}"><td colspan="4" style="text-align:right;font-weight:800;background:#e0f2fe;color:#0f172a;padding:10px 14px;">Monthly Total — ${escapeHtml(monthLabel(monthKey))}</td><td style="font-weight:800;background:#e0f2fe;color:#0369a1;">${formatCurrency(monthDebit)}</td><td style="font-weight:800;background:#e0f2fe;color:#0369a1;">${formatCurrency(monthCredit)}</td><td style="background:#e0f2fe;"></td></tr>`;
					grandDebit += monthDebit;
					grandCredit += monthCredit;
				}
				html += `<tr class="ledger-grand-total"><td colspan="4" style="text-align:right;font-weight:800;background:#1e40af;color:#fff;padding:10px 14px;font-size:0.95rem;">GRAND TOTAL</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(grandDebit)}</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(grandCredit)}</td><td style="background:#1e40af;"></td></tr>`;
				ledgerBody.innerHTML = ledgerDraftRow + html;
			}
			if (!ledgerBody.dataset.monthToggleBound) {
				ledgerBody.dataset.monthToggleBound = '1';
				ledgerBody.addEventListener('click', (event) => {
					const toggle = event.target.closest('.accounting-month-toggle[data-ledger-month]');
					if (!toggle) return;
					const monthKey = toggle.getAttribute('data-ledger-month');
					if (!monthKey) return;
					const willCollapse = !collapsedLedgerMonths.has(monthKey);
					if (willCollapse) collapsedLedgerMonths.add(monthKey);
					else collapsedLedgerMonths.delete(monthKey);
					saveCollapsedLedgerMonths(collapsedLedgerMonths);
					renderAccountingPage();
				});
			}
		}

		/* Cashbook — grouped by month, then day, with subtotals */
		const cashbookBody = document.getElementById('cashbook-tbody');
		if (cashbookBody) {
			const cashbookDraftRow = cashbookDraft ? `<tr class="draft-row"><td>${escapeHtml(cashbookDraft.date || '')}</td><td>${escapeHtml(cashbookDraft.desc || 'Unsaved cashbook entry')}</td><td>${escapeHtml(cashbookDraft.amount || '')}</td><td></td><td><div class="row-actions"><button class="btn-edit acc-resume-draft-btn" data-draft-entity="cashbook" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete acc-clear-draft-btn" data-draft-entity="cashbook" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td></tr>` : '';
			if (cashbook.length === 0) {
				cashbookBody.innerHTML = cashbookDraftRow || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No entries yet. Click "Add Entry" to start.</td></tr>';
			} else {
				const byMonth = {};
				cashbook.forEach((entry, idx) => {
					const monthKey = String(entry.date || '').slice(0, 7) || 'Unknown';
					const dateKey = entry.date || 'Unknown';
					if (!byMonth[monthKey]) byMonth[monthKey] = {};
					if (!byMonth[monthKey][dateKey]) byMonth[monthKey][dateKey] = [];
					byMonth[monthKey][dateKey].push({ ...entry, _idx: idx });
				});
				const sortedMonths = Object.keys(byMonth).sort();
				const newestMonth = sortedMonths[sortedMonths.length - 1] || null;
				collapsedCashbookMonths = new Set([...collapsedCashbookMonths].filter((monthKey) => byMonth[monthKey]));
				if (newestMonth && sortedMonths.length > 1 && !collapsedCashbookMonths.size) {
					sortedMonths.slice(0, -1).forEach((monthKey) => collapsedCashbookMonths.add(monthKey));
					saveCollapsedCashbookMonths(collapsedCashbookMonths);
				}
				let html = '';
				let grandTotal = 0;
				for (const monthKey of sortedMonths) {
					const datesInMonth = byMonth[monthKey];
					const sortedDates = Object.keys(datesInMonth).sort();
					const isCollapsed = collapsedCashbookMonths.has(monthKey);
					let monthTotal = 0;
					html += `<tr class="cashbook-month-header"><td colspan="5" style="padding:0;"><button type="button" class="accounting-month-toggle${isCollapsed ? ' is-collapsed' : ''}" data-cashbook-month="${escapeHtml(monthKey)}" aria-expanded="${isCollapsed ? 'false' : 'true'}"><span class="accounting-month-toggle-left"><i class="fa-solid fa-chevron-right accounting-month-chevron${isCollapsed ? '' : ' is-open'}"></i><i class="fa-solid fa-calendar-days"></i><span>${escapeHtml(monthLabel(monthKey))}</span></span><span class="accounting-month-toggle-meta">${sortedDates.length} day${sortedDates.length === 1 ? '' : 's'}</span></button></td></tr>`;
					for (const date of sortedDates) {
						const entries = datesInMonth[date];
						let dayTotal = 0;
						const dateLabel = accountingDateLabel(date);
						html += `<tr class="cashbook-date-header accounting-month-row${isCollapsed ? ' is-hidden' : ''}" data-cashbook-month-row="${escapeHtml(monthKey)}"><td colspan="5" style="background:#f0f4ff;font-weight:700;color:#1e40af;padding:10px 14px 10px 26px;border-top:1px solid #bfdbfe;font-size:0.95rem;"><i class="fa-solid fa-calendar-day" style="margin-right:6px;"></i>${escapeHtml(dateLabel)}</td></tr>`;
						for (const entry of entries) {
							dayTotal += entry.amount || 0;
							grandTotal += entry.amount || 0;
							html += `<tr class="accounting-month-row${isCollapsed ? ' is-hidden' : ''}" data-cashbook-month-row="${escapeHtml(monthKey)}"><td>${escapeHtml(entry.date || '')}</td><td>${escapeHtml(entry.desc || '')}</td><td>${formatCurrency(entry.amount)}</td><td>${formatCurrency(grandTotal)}</td><td><div class="row-actions"><button class="btn-edit acc-edit-btn" data-edit-entity="cashbook" data-edit-idx="${entry._idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete acc-delete-btn" data-delete-entity="cashbook" data-delete-idx="${entry._idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
						}
						html += `<tr class="cashbook-subtotal accounting-month-row${isCollapsed ? ' is-hidden' : ''}" data-cashbook-month-row="${escapeHtml(monthKey)}"><td colspan="2" style="text-align:right;font-weight:700;background:#f8fafc;color:#475569;padding:8px 14px;">Subtotal — ${escapeHtml(dateLabel)}</td><td style="font-weight:700;background:#f8fafc;color:#1e40af;">${formatCurrency(dayTotal)}</td><td style="background:#f8fafc;"></td><td style="background:#f8fafc;"></td></tr>`;
						monthTotal += dayTotal;
					}
					html += `<tr class="cashbook-month-total accounting-month-row${isCollapsed ? ' is-hidden' : ''}" data-cashbook-month-row="${escapeHtml(monthKey)}"><td colspan="2" style="text-align:right;font-weight:800;background:#e0f2fe;color:#0f172a;padding:10px 14px;">Monthly Total — ${escapeHtml(monthLabel(monthKey))}</td><td style="font-weight:800;background:#e0f2fe;color:#0369a1;">${formatCurrency(monthTotal)}</td><td style="background:#e0f2fe;"></td><td style="background:#e0f2fe;"></td></tr>`;
				}
				html += `<tr><td colspan="2" style="text-align:right;font-weight:800;background:#1e40af;color:#fff;padding:10px 14px;font-size:0.95rem;">GRAND TOTAL</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(grandTotal)}</td><td style="background:#1e40af;"></td><td style="background:#1e40af;"></td></tr>`;
				cashbookBody.innerHTML = cashbookDraftRow + html;
			}
			if (!cashbookBody.dataset.monthToggleBound) {
				cashbookBody.dataset.monthToggleBound = '1';
				cashbookBody.addEventListener('click', (event) => {
					const toggle = event.target.closest('.accounting-month-toggle[data-cashbook-month]');
					if (!toggle) return;
					const monthKey = toggle.getAttribute('data-cashbook-month');
					if (!monthKey) return;
					const willCollapse = !collapsedCashbookMonths.has(monthKey);
					if (willCollapse) collapsedCashbookMonths.add(monthKey);
					else collapsedCashbookMonths.delete(monthKey);
					saveCollapsedCashbookMonths(collapsedCashbookMonths);
					renderAccountingPage();
				});
			}

			const totalSpent = cashbook.reduce((sum, e) => sum + (e.amount || 0), 0);
			const cashSummary = document.getElementById('cashbook-summary-cards');
			if (cashSummary) {
				cashSummary.innerHTML = `
					<div class="cashbook-card"><p class="cb-label">Total Expenditure</p><p class="cb-val">${formatCurrency(totalSpent)}</p></div>
					<div class="cashbook-card"><p class="cb-label">Entries</p><p class="cb-val">${cashbook.length}</p></div>
				`;
			}
		}

		/* Account Summary */
		const summaryGrid = document.getElementById('account-summary-grid');
		if (summaryGrid) {
			summaryGrid.innerHTML = accountSummary.length === 0
				? '<p style="color:#94a3b8;text-align:center;grid-column:1/-1;">No accounts yet. Click "Add Account" to start.</p>'
				: accountSummary.map((cat) => {
					return `<div class="category-card"><h4>${cat.category}</h4>${cat.accounts.map((acc) => `<div class="cat-row"><span>${acc.name}</span><span>${formatCurrency(acc.value)}</span></div>`).join('')}<div class="cat-total"><span>Total</span><span>${formatCurrency(cat.total)}</span></div></div>`;
				}).join('');
		}

		const expensePeriodSelect = document.getElementById('acc-expense-period-select');
		const expenseChartHost = document.getElementById('acc-expense-distribution-chart');
		const expenseCategoryList = document.getElementById('acc-expense-category-list');
		const expenseTotalValue = document.getElementById('acc-expense-total-value');
		const expenseCards = document.getElementById('acc-expense-breakdown-cards');
		if (expensePeriodSelect) {
			expensePeriodSelect.innerHTML = ['<option value="__all__">All periods</option>']
				.concat(expensePeriods.map((period) => `<option value="${period}">${monthLabel(period)}</option>`))
				.join('');
			expensePeriodSelect.value = currentExpensePeriod;
			if (!expensePeriodSelect.dataset.bound) {
				expensePeriodSelect.dataset.bound = '1';
				expensePeriodSelect.addEventListener('change', () => {
					currentExpensePeriod = expensePeriodSelect.value || '__all__';
					renderAccountingPage();
				});
			}
		}
		if (expenseTotalValue) {
			expenseTotalValue.textContent = formatCurrency(expenseBreakdownTotal);
		}
		if (expenseCategoryList) {
			expenseCategoryList.innerHTML = expenseBreakdownRows.map((row) => `
				<div class="expense-category-item">
					<div class="expense-category-main">
						<span class="pie-swatch" style="background:${row.color}"></span>
						<div class="expense-category-labels">
							<span class="expense-category-name">${escapeHtml(row.category)}</span>
							<span class="expense-category-meta">${row.percent.toFixed(1)}% of total expenses</span>
						</div>
					</div>
					<div class="expense-category-values">
						<span class="expense-category-amount">${formatCurrency(row.amount)}</span>
						<span class="expense-category-percent">${row.percent.toFixed(1)}%</span>
					</div>
				</div>
			`).join('');
		}
		if (expenseCards) {
			expenseCards.innerHTML = expenseBreakdownRows.map((row) => `
				<article class="expense-detail-card">
					<div class="expense-detail-top">
						<span class="pie-swatch" style="background:${row.color}"></span>
						<span class="expense-detail-name">${escapeHtml(row.category)}</span>
					</div>
					<p class="expense-detail-amount">${formatCurrency(row.amount)}</p>
					<p class="expense-detail-percent">${row.percent.toFixed(1)}% of total expenses</p>
				</article>
			`).join('');
		}
		if (expenseChartHost) {
			if (window.__accExpenseChart) {
				window.__accExpenseChart.destroy();
				window.__accExpenseChart = null;
			}
			if (!chartExpenseRows.length) {
				expenseChartHost.innerHTML = `<div class="expense-chart-empty">No expense distribution available for ${currentExpensePeriod === '__all__' ? 'the selected periods' : monthLabel(currentExpensePeriod)}.</div>`;
			} else if (typeof Chart === 'undefined') {
				expenseChartHost.innerHTML = `<div class="expense-chart-empty">Chart library unavailable. Expense totals are shown in the list and cards.</div>`;
			} else {
				expenseChartHost.innerHTML = '<canvas id="acc-expense-chart-canvas" aria-label="Expense Distribution pie chart"></canvas>';
				const expenseCanvas = document.getElementById('acc-expense-chart-canvas');
				if (expenseCanvas) {
					window.__accExpenseChart = new Chart(expenseCanvas, {
						type: 'pie',
						data: {
							labels: chartExpenseRows.map((row) => row.category),
							datasets: [{
								data: chartExpenseRows.map((row) => Number(row.amount.toFixed(2))),
								backgroundColor: chartExpenseRows.map((row) => row.color),
								borderColor: '#ffffff',
								borderWidth: 2,
								hoverOffset: 8,
							}],
						},
						options: {
							responsive: true,
							maintainAspectRatio: false,
							plugins: {
								legend: { display: false },
								tooltip: {
									callbacks: {
										label: (ctx) => {
											const amount = Number(ctx.parsed || 0);
											const percent = expenseBreakdownTotal > 0 ? (amount / expenseBreakdownTotal) * 100 : 0;
											return `${ctx.label}: ${formatCurrency(amount)} (${percent.toFixed(1)}%)`;
										},
									},
								},
							},
						},
					});
				}
			}
		}

		/* Multi-Currency */
		const currencyGrid = document.getElementById('currency-grid');
		if (currencyGrid) {
			currencyGrid.innerHTML = currencies.length === 0
				? '<p style="color:#94a3b8;text-align:center;grid-column:1/-1;">No currencies yet. Click "Add Currency" to start.</p>'
				: currencies.map((cur) => {
					const sample = cur.rate > 0 ? (100 / cur.rate).toFixed(2) : '0.00';
					const icon = CURRENCY_ICONS[cur.code] || 'fa-solid fa-coins';
					return `<div class="currency-card"><div class="cur-top"><div class="cur-left"><span class="cur-globe"><i class="fa-solid fa-globe"></i></span><div><p class="cur-code">${cur.code}</p><p class="cur-name">${cur.name}</p></div></div><span class="cur-symbol"><i class="${icon}"></i></span></div><p class="cur-rate">1 ${cur.code} = ${cur.rate.toFixed(2)} GH₵</p><p class="cur-sample">100 GH₵ ≈ ${sample} ${cur.code}</p></div>`;
				}).join('');
		}

		taxRenderTable();

		/* Assets Sheet */
		const assetsArr = accountingData.assets;
		const assetsBody = document.getElementById('assets-tbody');
		if (assetsBody) {
			const assetDraftRow = assetDraft ? `<tr class="draft-row"><td>${escapeHtml(assetDraft.date || '')}</td><td style="font-weight:600;">${escapeHtml(assetDraft.name || 'Unsaved asset')}</td><td>${escapeHtml(assetDraft.category || '')}</td><td>${escapeHtml(assetDraft.value || '')}</td><td style="color:#64748b;font-size:0.85rem;">${escapeHtml(assetDraft.note || '')}</td><td><div class="row-actions"><button class="btn-edit acc-resume-draft-btn" data-draft-entity="asset-item" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete acc-clear-draft-btn" data-draft-entity="asset-item" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td></tr>` : '';
			if (assetsArr.length === 0) {
				assetsBody.innerHTML = assetDraftRow || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;">No assets yet. Click "Add Asset" to start.</td></tr>';
			} else {
				const sorted = assetsArr.map((a, i) => ({ ...a, _idx: i })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
				let html = '';
				let grandTotal = 0;
				// Group by category
				const byCat = {};
				for (const a of sorted) {
					const cat = a.category || 'Other';
					if (!byCat[cat]) byCat[cat] = [];
					byCat[cat].push(a);
				}
				for (const cat of Object.keys(byCat).sort()) {
					let catTotal = 0;
					html += `<tr><td colspan="6" style="background:#f0f4ff;font-weight:700;color:#1e40af;padding:10px 14px;border-top:2px solid #bfdbfe;font-size:0.95rem;"><i class="fa-solid fa-box" style="margin-right:6px;"></i>${cat}</td></tr>`;
					for (const a of byCat[cat]) {
						catTotal += a.value || 0;
						grandTotal += a.value || 0;
						html += `<tr><td>${a.date}</td><td style="font-weight:600;">${a.name}</td><td>${a.category}</td><td>${formatCurrency(a.value)}</td><td style="color:#64748b;font-size:0.85rem;">${a.note || '—'}</td><td><div class="row-actions"><button class="btn-edit acc-edit-btn" data-edit-entity="asset-item" data-edit-idx="${a._idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete acc-delete-btn" data-delete-entity="asset-item" data-delete-idx="${a._idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
					}
					html += `<tr><td colspan="3" style="text-align:right;font-weight:700;background:#f8fafc;color:#475569;padding:8px 14px;">Subtotal — ${cat}</td><td style="font-weight:700;background:#f8fafc;color:#1e40af;">${formatCurrency(catTotal)}</td><td colspan="2" style="background:#f8fafc;"></td></tr>`;
				}
				html += `<tr><td colspan="3" style="text-align:right;font-weight:800;background:#1e40af;color:#fff;padding:10px 14px;font-size:0.95rem;">TOTAL ASSETS</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(grandTotal)}</td><td colspan="2" style="background:#1e40af;"></td></tr>`;
				assetsBody.innerHTML = assetDraftRow + html;
			}
			const assetsSummary = document.getElementById('assets-summary-cards');
			if (assetsSummary) {
				const total = assetsArr.reduce((s, a) => s + (a.value || 0), 0);
				const cats = new Set(assetsArr.map(a => a.category || 'Other')).size;
				assetsSummary.innerHTML = `
					<div style="display:flex;gap:16px;flex-wrap:wrap;">
						<div class="cashbook-card"><p class="cb-label">Total Assets Value</p><p class="cb-val">${formatCurrency(total)}</p></div>
						<div class="cashbook-card"><p class="cb-label">Items</p><p class="cb-val">${assetsArr.length}</p></div>
						<div class="cashbook-card"><p class="cb-label">Categories</p><p class="cb-val">${cats}</p></div>
					</div>
				`;
			}
		}

		/* Salaries — filtered by selected week */
		const salaries = accountingData.salaries;
		const salariesBody = document.getElementById('salaries-tbody');
		const weekSelect = document.getElementById('salary-week-select');
		const weekRange = document.getElementById('salary-week-range');
		const printEmployeeSelect = document.getElementById('salary-print-employee-select');

		// Build unique groups: weeks for old entries, months for new entries
		const allMonths = [...new Set(salaries.map(s => getSalaryGroup(s)).filter(Boolean))].sort();
		if (!currentSalaryMonth && allMonths.length > 0) currentSalaryMonth = allMonths[allMonths.length - 1];

		if (weekSelect) {
			weekSelect.innerHTML = allMonths.length === 0
				? '<option value="">No records</option>'
				: '<option value="__all__" ' + (currentSalaryMonth === '__all__' ? 'selected' : '') + '>All</option>'
					+ allMonths.map(m => `<option value="${m}" ${m === currentSalaryMonth ? 'selected' : ''}>${groupLabel(m)}</option>`).join('');
			if (!weekSelect.dataset.bound) {
				weekSelect.dataset.bound = '1';
				weekSelect.addEventListener('change', () => {
					currentSalaryMonth = weekSelect.value;
					currentSalaryEmployee = '__all_workers__';
					renderAccountingPage();
				});
			}
		}
		if (weekRange && currentSalaryMonth && currentSalaryMonth !== '__all__') {
			weekRange.textContent = groupLabel(currentSalaryMonth);
		} else if (weekRange && currentSalaryMonth === '__all__') {
			weekRange.textContent = 'Showing all. Select one to view entries.';
		} else if (weekRange) {
			weekRange.textContent = '';
		}

		// Filter salaries by selected group
		const filtered = currentSalaryMonth === '__all__'
			? salaries.map((s, idx) => ({ ...s, _idx: idx }))
			: salaries.map((s, idx) => ({ ...s, _idx: idx })).filter(s => getSalaryGroup(s) === currentSalaryMonth);

		if (printEmployeeSelect) {
			if (currentSalaryMonth === '__all__') {
				printEmployeeSelect.innerHTML = '<option value="__all_workers__">Select period first</option>';
				printEmployeeSelect.value = '__all_workers__';
				printEmployeeSelect.disabled = true;
				currentSalaryEmployee = '__all_workers__';
			} else {
				const workers = [...new Set(filtered.map((s) => s.employee).filter(Boolean))].sort((a, b) => a.localeCompare(b));
				printEmployeeSelect.innerHTML = workers.length === 0
					? '<option value="__all_workers__">No workers in this period</option>'
					: '<option value="__all_workers__">All workers</option>' + workers.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
				if (currentSalaryEmployee !== '__all_workers__' && !workers.includes(currentSalaryEmployee)) {
					currentSalaryEmployee = '__all_workers__';
				}
				printEmployeeSelect.value = currentSalaryEmployee;
				printEmployeeSelect.disabled = workers.length === 0;
				if (!printEmployeeSelect.dataset.bound) {
					printEmployeeSelect.dataset.bound = '1';
					printEmployeeSelect.addEventListener('change', () => {
						currentSalaryEmployee = printEmployeeSelect.value || '__all_workers__';
					});
				}
			}
		}

		if (salariesBody) {
			const salaryDraftRow = salaryDraft ? `<tr class="draft-row"><td>${escapeHtml(salaryDraft.date || '')}</td><td style="font-weight:600;">${escapeHtml(salaryDraft.employee || 'Unsaved salary')}</td><td style="color:#64748b;font-size:0.85rem;">${escapeHtml(salaryDraft.month || '')}</td><td>${escapeHtml(salaryDraft.amount || '')}</td><td style="color:#64748b;font-size:0.85rem;">${escapeHtml(salaryDraft.note || '')}</td><td><div class="row-actions"><button class="btn-edit acc-resume-draft-btn" data-draft-entity="salary" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete acc-clear-draft-btn" data-draft-entity="salary" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td></tr>` : '';
			if (currentSalaryMonth === '__all__') {
				if (allMonths.length === 0) {
					salariesBody.innerHTML = salaryDraftRow || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;">No salary records yet.</td></tr>';
				} else {
					const monthRows = allMonths.map((mo) => {
						const monthItems = salaries.filter((s) => getSalaryGroup(s) === mo);
						const monthTotal = monthItems.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
						const paidStaff = new Set(monthItems.map((s) => s.employee)).size;
						const paidDate = monthItems
							.map((s) => s.date)
							.filter(Boolean)
							.sort()
							.slice(-1)[0] || '—';
						return `<tr><td>${paidDate}</td><td style="font-weight:600;">${paidStaff} staff</td><td style="color:#64748b;font-size:0.85rem;">${groupLabel(mo)}</td><td>${formatCurrency(monthTotal)}</td><td style="color:#64748b;font-size:0.85rem;">${monthItems.length} entries</td><td><button type="button" class="btn-secondary acc-week-pick-btn" data-month="${mo}">Select</button></td></tr>`;
					}).join('');
					salariesBody.innerHTML = salaryDraftRow + monthRows;
				}
			} else if (filtered.length === 0) {
				salariesBody.innerHTML = salaryDraftRow || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;">No salary records for this period.</td></tr>';
			} else {
				let html = '';
				let total = 0;
				for (const s of filtered) {
					total += s.amount || 0;
					const grp = getSalaryGroup(s);
					html += `<tr><td>${s.date}</td><td style="font-weight:600;"><span class="salary-name-link" data-salary-employee="${escapeHtml(s.employee || '')}" data-salary-month="${escapeHtml(grp)}" title="Open salary slip for ${escapeHtml(s.employee || '')}">${s.employee}</span></td><td style="color:#64748b;font-size:0.85rem;">${groupLabel(grp)}</td><td>${formatCurrency(s.amount)}</td><td style="color:#64748b;font-size:0.85rem;">${s.note || '—'}</td><td><div class="row-actions"><button class="btn-edit acc-edit-btn" data-edit-entity="salary" data-edit-idx="${s._idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete acc-delete-btn" data-delete-entity="salary" data-delete-idx="${s._idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
				}
				html += `<tr><td colspan="3" style="text-align:right;font-weight:800;background:#1e40af;color:#fff;padding:10px 14px;font-size:0.95rem;">TOTAL</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(total)}</td><td style="background:#1e40af;" colspan="2"></td></tr>`;
				salariesBody.innerHTML = salaryDraftRow + html;
			}

			const salSummary = document.getElementById('salaries-summary-cards');
			if (salSummary) {
				const monthPaid = filtered.reduce((s, e) => s + (e.amount || 0), 0);
				const allPaid = salaries.reduce((s, e) => s + (e.amount || 0), 0);
				const uniqueStaff = currentSalaryMonth === '__all__'
					? new Set(salaries.map(s => s.employee)).size
					: new Set(filtered.map(s => s.employee)).size;
				const monthCardLabel = currentSalaryMonth === '__all__' ? 'Selected Period' : 'This Period';
				const monthCardValue = currentSalaryMonth === '__all__' ? 'Choose Period' : formatCurrency(monthPaid);
				salSummary.innerHTML = `
					<div style="display:flex;gap:16px;flex-wrap:wrap;">
						<div class="cashbook-card"><p class="cb-label">${monthCardLabel}</p><p class="cb-val">${monthCardValue}</p></div>
						<div class="cashbook-card"><p class="cb-label">Staff Paid</p><p class="cb-val">${uniqueStaff}</p></div>
						<div class="cashbook-card"><p class="cb-label">All-time Total</p><p class="cb-val">${formatCurrency(allPaid)}</p></div>
					</div>
				`;
			}
		}
	}

	function printCurrentSalarySelection() {
		if (currentSalaryMonth === '__all__') {
			alert('Select a specific month first, then print salaries.');
			return;
		}

		const salaries = accountingData.salaries;
		const rows = salaries
			.map((s) => ({ ...s, _grp: getSalaryGroup(s) }))
			.filter((s) => s._grp === currentSalaryMonth);
		const weekWorkers = [...new Set(rows.map((r) => r.employee).filter(Boolean))];
		const selectedWorkers = (currentSalaryEmployee && currentSalaryEmployee !== '__all_workers__')
			? weekWorkers.filter((name) => name === currentSalaryEmployee)
			: weekWorkers;
		const selectedRows = rows.filter((r) => selectedWorkers.includes(r.employee));

		if (selectedRows.length === 0) {
			alert('No salary records to print for this selection.');
			return;
		}

		selectedRows.sort((a, b) => {
			const dateCmp = String(a.date || '').localeCompare(String(b.date || ''));
			if (dateCmp !== 0) return dateCmp;
			return String(a.employee || '').localeCompare(String(b.employee || ''));
		});

		const generatedAt = new Date().toLocaleString('en-GB');
		const monthText = groupLabel(currentSalaryMonth);
		const isSlipMonth = currentSalaryMonth >= '2026-05';

		let printHtml;

		if (isSlipMonth) {
			// ── Full salary-slip printout (May 2026+) ───────────────────
			const origin = window.location.origin;
			const logoUrl = `${origin}/images/New%20Logo.jpeg`;
			const fmtGHS = (n) => 'GH₵ ' + Number(n).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

			const slipSections = [...selectedWorkers].sort((a, b) => a.localeCompare(b)).map((worker, idx) => {
				const rec = selectedRows.find((r) => r.employee === worker) || {};
				const sd = rec.slipData; // full line-item data saved with the record
				const notesArr = Array.isArray(rec.notes) ? rec.notes : [];
				const getNoteVal = (prefix) => {
					const found = notesArr.find((n) => n.startsWith(prefix));
					return found ? found.slice(prefix.length).trim() : '';
				};
				// Prefer slipData fields; fall back to notes for older records
				const dept     = (sd && sd.dept)     || getNoteVal('Dept: ');
				const position = (sd && sd.position) || getNoteVal('Position: ');
				const empId    = (sd && sd.id)       || getNoteVal('ID: ');
				const net      = rec.amount || 0;

				// Build data rows for a section (filter out zero-amount rows)
				const buildRows = (rows, isDeduct) => rows
					.filter((r) => r.amt !== 0)
					.map((r) => `<tr class="sp-row">
						<td>${escapeHtml(r.desc)}</td>
						<td class="sp-rate">${escapeHtml(r.rate && r.rate !== '\u2014' && r.rate !== '%' ? r.rate : '\u2014')}</td>
						<td class="sp-r${isDeduct ? ' sp-deduct' : ''}">${fmtGHS(r.amt)}</td>
					</tr>`).join('');

				let earningsHtml, allowHtml, deductHtml, grossTotal, allowTotal, dedTotal;

				if (sd) {
					grossTotal = sd.gross;
					allowTotal = sd.totalAllowances;
					dedTotal   = sd.totalDeductions;
					earningsHtml = buildRows(sd.earnings   || [], false);
					deductHtml   = buildRows(sd.deductions || [], true);
					allowHtml = (sd.allowances && sd.allowances.length > 0 && allowTotal > 0) ? `
						<table class="sp-table">
							<tr class="sp-sec-hdr"><td colspan="3">Allowances</td></tr>
							<tr class="sp-col-hdr"><td>Description</td><td class="sp-rate">Rate</td><td class="sp-r">Amount (GH₵)</td></tr>
							${buildRows(sd.allowances, false)}
							<tr class="sp-total"><td colspan="2">Total Allowances</td><td class="sp-r">${fmtGHS(allowTotal)}</td></tr>
						</table>` : '';
				} else {
					// Older records saved without slipData — fall back to summary totals
					const grossStr = getNoteVal('Gross: GH₵ ') || getNoteVal('Gross: GHS ');
					const allowStr = getNoteVal('Allowances: GH₵ ') || getNoteVal('Allowances: GHS ');
					const dedStr   = getNoteVal('Deductions: GH₵ ') || getNoteVal('Deductions: GHS ');
					grossTotal = parseFloat((grossStr || '0').replace(/,/g, '')) || 0;
					allowTotal = parseFloat((allowStr || '0').replace(/,/g, '')) || 0;
					dedTotal   = parseFloat((dedStr   || '0').replace(/,/g, '')) || 0;
					earningsHtml = `<tr class="sp-row"><td>Gross Pay</td><td class="sp-rate">\u2014</td><td class="sp-r">${fmtGHS(grossTotal)}</td></tr>`;
					deductHtml   = `<tr class="sp-row"><td>Total Deductions</td><td class="sp-rate">\u2014</td><td class="sp-r sp-deduct">${fmtGHS(dedTotal)}</td></tr>`;
					allowHtml = allowTotal > 0 ? `
						<table class="sp-table">
							<tr class="sp-sec-hdr"><td colspan="3">Allowances</td></tr>
							<tr class="sp-col-hdr"><td>Description</td><td class="sp-rate">Rate</td><td class="sp-r">Amount (GH₵)</td></tr>
							<tr class="sp-row"><td>Total Allowances</td><td class="sp-rate">\u2014</td><td class="sp-r">${fmtGHS(allowTotal)}</td></tr>
							<tr class="sp-total"><td colspan="2">Total Allowances</td><td class="sp-r">${fmtGHS(allowTotal)}</td></tr>
						</table>` : '';
				}

				return `
				<div class="sp-wrap${idx > 0 ? ' page-break' : ''}">
					<div class="sp-header">
						<div class="sp-logo-block">
							<img src="${logoUrl}" onerror="this.style.display='none'" alt="logo">
							<div>
								<div class="sp-company-name">WHITE WATER WELLS LTD</div>
								<div class="sp-company-sub">Water Factory</div>
								<div class="sp-company-slogan">Pure. Safe. Reliable Drinking Water</div>
							</div>
						</div>
						<div class="sp-title-block">
							<div class="sp-title">SALARY SLIP</div>
							<div class="sp-meta">Pay Period: <strong>${escapeHtml(monthText)}</strong></div>
							<div class="sp-meta">Date Issued: <strong>${escapeHtml(rec.date || generatedAt)}</strong></div>
						</div>
					</div>
					<div class="sp-emp-row">
						<div class="sp-emp-col">
							<div class="sp-ef"><span class="sp-lbl">Name:</span><strong>${escapeHtml(worker)}</strong></div>
							${empId    ? `<div class="sp-ef"><span class="sp-lbl">Employee ID:</span><strong>${escapeHtml(empId)}</strong></div>` : ''}
							${position ? `<div class="sp-ef"><span class="sp-lbl">Position:</span><strong>${escapeHtml(position)}</strong></div>` : ''}
						</div>
						<div class="sp-emp-col">
							${dept ? `<div class="sp-ef"><span class="sp-lbl">Department:</span><strong>${escapeHtml(dept)}</strong></div>` : ''}
						</div>
					</div>
					<table class="sp-table">
						<tr class="sp-sec-hdr"><td colspan="3">Earnings</td></tr>
						<tr class="sp-col-hdr"><td>Description</td><td class="sp-rate">Rate</td><td class="sp-r">Amount (GH₵)</td></tr>
						${earningsHtml}
						<tr class="sp-total"><td colspan="2">Total Gross Pay</td><td class="sp-r">${fmtGHS(grossTotal)}</td></tr>
					</table>
					${allowHtml}
					<table class="sp-table">
						<tr class="sp-sec-hdr"><td colspan="3">Deductions</td></tr>
						<tr class="sp-col-hdr"><td>Description</td><td class="sp-rate">Rate</td><td class="sp-r">Amount (GH₵)</td></tr>
						${deductHtml}
						<tr class="sp-total"><td colspan="2">Total Deductions</td><td class="sp-r sp-deduct">${fmtGHS(dedTotal)}</td></tr>
					</table>
					<div class="sp-netpay">
						<div>
							<div class="sp-netlabel">NET PAY / TAKE HOME</div>
							<div class="sp-netsub">Gross Pay + Allowances &minus; Deductions</div>
						</div>
						<div class="sp-netamt">${fmtGHS(net)}</div>
					</div>
					<div class="sp-footer">
						White Water Wells Ltd &nbsp;&middot;&nbsp; Comm 25 Peace B Down Accra-Prampram Road, P.O. Box 18204, Accra &nbsp;&middot;&nbsp; Tel: 0243108878 / 0244483793 &nbsp;&middot;&nbsp; whitewaterwellscompanyltd@gmail.com<br>
						Generated: ${escapeHtml(generatedAt)}
						<div style="margin-top:6px;font-size:10.5px;color:#b0bec5;letter-spacing:.5px;">Page 1 of 1</div>
					</div>
				</div>`;
			}).join('');

			printHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Salary Slips \u2014 ${escapeHtml(monthText)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f1f5f9; color: #0f172a; }
    .sp-wrap { background: #fff; border: 1px solid #d1dbe8; border-radius: 10px; max-width: 820px; margin: 24px auto; overflow: hidden; }
    .page-break { page-break-before: always; break-before: page; margin-top: 0; border-radius: 0; }
    .sp-header { background: #1a56db; color: #fff; display: flex; justify-content: space-between; align-items: flex-start; padding: 20px 26px 18px; gap: 20px; }
    .sp-logo-block { display: flex; align-items: center; gap: 14px; }
    .sp-logo-block img { width: 58px; height: 58px; object-fit: contain; border-radius: 8px; background: #fff; padding: 3px; }
    .sp-company-name   { font-size: 17px; font-weight: 700; letter-spacing: .4px; line-height: 1.2; }
    .sp-company-sub    { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; opacity: .8; margin-top: 3px; }
    .sp-company-slogan { font-size: 10.5px; font-style: italic; opacity: .75; margin-top: 4px; letter-spacing: .3px; }
    .sp-title-block { text-align: right; }
    .sp-title { font-size: 24px; font-weight: 800; letter-spacing: 1px; line-height: 1; }
    .sp-meta  { font-size: 12px; opacity: .88; margin-top: 5px; line-height: 1.7; }
    .sp-emp-row { display: grid; grid-template-columns: 1fr 1fr; padding: 16px 26px; border-bottom: 2px solid #e2e8f0; gap: 8px; }
    .sp-emp-col { display: flex; flex-direction: column; gap: 8px; }
    .sp-ef  { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
    .sp-lbl { color: #6b7280; min-width: 90px; font-size: 12.5px; }
    .sp-table { width: 100%; border-collapse: collapse; }
    .sp-sec-hdr td { padding: 8px 26px; font-size: 11.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: #fff; background: #1a56db; }
    .sp-col-hdr td { padding: 6px 26px; font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #6b7280; border-bottom: 1px solid #e2e8f0; }
    .sp-rate { text-align: center; width: 110px; }
    .sp-r    { text-align: right;  width: 130px; }
    .sp-row td   { padding: 9px 26px; font-size: 13px; color: #1e293b; border-bottom: 1px solid #f0f4f8; }
    .sp-row:hover td { background: #f8fafd; }
    .sp-total td { padding: 10px 26px; font-size: 13.5px; font-weight: 700; border-top: 2px solid #e2e8f0; color: #1a56db; }
    .sp-deduct { color: #e53e3e !important; }
    .sp-netpay   { background: #1a56db; color: #fff; padding: 16px 26px; display: flex; justify-content: space-between; align-items: center; }
    .sp-netlabel { font-size: 13.5px; font-weight: 700; }
    .sp-netsub   { font-size: 11px; opacity: .75; margin-top: 3px; }
    .sp-netamt   { font-size: 22px; font-weight: 800; }
    .sp-footer   { text-align: center; font-size: 11px; color: #94a3b8; padding: 10px 26px 12px; border-top: 1px solid #e2e8f0; line-height: 1.7; }
    @media print {
      body { background: #fff !important; }
      .sp-wrap { border: none; border-radius: 0; max-width: 100%; margin: 0; }
      .sp-header, .sp-sec-hdr td, .sp-netpay { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #1a56db !important; }
    }
  </style>
</head>
<body>
  ${slipSections}
</body>
</html>`;

		} else {
			// ── Simple table printout (pre-May 2026) ────────────────────
			const title = 'White Water Wells - Salary Payments';
			const printCss = `${window.location.origin}/src/script.css?v=20260504`;

			const sectionsHtml = selectedWorkers.sort((a, b) => a.localeCompare(b)).map((worker, workerIndex) => {
				const workerRows = selectedRows.filter((r) => r.employee === worker);
				const workerTotal = workerRows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
				const bodyRows = workerRows.map((r) => {
					return `<tr><td>${escapeHtml(r.date || '')}</td><td>${escapeHtml(groupLabel(r._grp))}</td><td style="text-align:right;">${formatCurrency(r.amount || 0)}</td><td>${escapeHtml(r.note || '—')}</td></tr>`;
				}).join('');
				return `
				<section class="worker-section${workerIndex > 0 ? ' page-break' : ''}">
					<div class="worker-head">
						<div>
							<h2>${escapeHtml(worker)}</h2>
							<p class="worker-week">${escapeHtml(monthText)}</p>
						</div>
						<div class="worker-total">Total: ${formatCurrency(workerTotal)}</div>
					</div>
					<table>
						<thead><tr><th>Date Paid</th><th>Month</th><th>Amount (GH₵)</th><th>Notes</th></tr></thead>
						<tbody>${bodyRows}<tr><td colspan="2" style="text-align:right;font-weight:700;">Total</td><td style="text-align:right;font-weight:700;">${formatCurrency(workerTotal)}</td><td></td></tr></tbody>
					</table>
				</section>
				`;
			}).join('');

			printHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="${printCss}">
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #fff; color: #0f172a; }
    .print-wrap { padding: 20px; }
    .print-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; border-bottom: 1px solid #e2e8f0; margin-bottom: 12px; padding-bottom: 8px; }
    .print-head h1 { font-size: 1.1rem; margin: 0; }
    .print-head p { font-size: 0.85rem; color: #64748b; margin: 0; }
    .worker-section { margin-top: 14px; }
    .worker-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
    .worker-section h2 { margin: 0; font-size: 1rem; }
    .worker-week { margin: 4px 0 0; font-size: 0.86rem; color: #64748b; }
    .worker-total { font-size: 0.95rem; font-weight: 700; white-space: nowrap; }
    .page-break { page-break-before: always; break-before: page; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e2e8f0; padding: 8px 10px; font-size: 0.9rem; vertical-align: top; }
    thead th { background: #f8fafc; text-align: left; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="print-wrap">
    <div class="print-head">
      <h1>${title}</h1>
      <p>Generated: ${generatedAt}</p>
    </div>
    ${sectionsHtml}
  </div>
</body>
</html>`;
		} // end else (pre-slip months)

		try {
			const printWin = window.open('', '_blank', 'width=1100,height=900');
			if (printWin && printWin.document) {
				printWin.document.open();
				printWin.document.write(printHtml);
				printWin.document.close();
				setTimeout(() => {
					try {
						printWin.focus();
						printWin.print();
					} catch (_e) {
						// ignored; fallback below handles hard failures.
					}
				}, 350);
				return;
			}
		} catch (_e) {
			// ignored; fallback below
		}

		try { window.print(); } catch (_err) { /* final fallback */ }
	}

	const salaryPrintBtn = document.getElementById('salary-week-print-btn');
	if (salaryPrintBtn && !salaryPrintBtn.dataset.bound) {
		salaryPrintBtn.dataset.bound = '1';
		salaryPrintBtn.addEventListener('click', printCurrentSalarySelection);
	}

	renderAccountingPage();
	taxLoadRecords();
	refreshAccountingFromServer();

	if (!window.__wwAccountingSyncBound) {
		window.__wwAccountingSyncBound = true;
		const reloadAccountingPage = () => {
			loadAccountingDataFromStorage();
			renderAccountingPage();
		};
		window.addEventListener('storage', (event) => {
			if (event.key === 'ww_accounting_data_v2' || event.key === 'ww_purchase_data_v2' || event.key === MONTHS_KEY || (event.key && event.key.startsWith('ww_sales_')) || event.key === 'ww_production_batches' || event.key === 'ww_daily_production') {
				reloadAccountingPage();
			}
		});
		const channels = ['ww_accounting_sync', 'ww_sales_sync', 'ww_purchase_sync'];
		for (const ch of channels) {
			try {
				const bc = new BroadcastChannel(ch);
				bc.onmessage = reloadAccountingPage;
			} catch (_e) { /* ignore */ }
		}
	}
	document.addEventListener('ww-refresh-page', renderAccountingPage);
}

	function initVaultPage() {
		if (document.body.getAttribute('data-page') !== 'vault') {
			return;
		}

		const sectionTabs = [...document.querySelectorAll('.rv-tab[data-rv-section]')];
		const searchEl = document.getElementById('rv-search');
		const categoryEl = document.getElementById('rv-category-filter');
		const dateFromEl = document.getElementById('rv-date-from');
		const dateToEl = document.getElementById('rv-date-to');
		const viewGridBtn = document.getElementById('rv-view-grid');
		const viewListBtn = document.getElementById('rv-view-list');
		const uploadOpenBtn = document.getElementById('rv-upload-open-btn');
		const fileContainer = document.getElementById('rv-file-container');
		const emptyState = document.getElementById('rv-empty-state');

		const uploadModal = document.getElementById('rv-upload-modal');
		const uploadModalClose = document.getElementById('rv-modal-close');
		const uploadModalCancel = document.getElementById('rv-upload-cancel-btn');
		const uploadSubmitBtn = document.getElementById('rv-upload-submit-btn');
		const dropzone = document.getElementById('rv-dropzone');
		const fileInput = document.getElementById('rv-file-input');
		const selectedFileEl = document.getElementById('rv-selected-file');
		const uploadCategoryEl = document.getElementById('rv-upload-category');
		const uploadFileNameEl = document.getElementById('rv-upload-file-name');
		const uploadAmountEl = document.getElementById('rv-upload-amount');
		const uploadDateEl = document.getElementById('rv-upload-date');
		const uploadNotesEl = document.getElementById('rv-upload-notes');
		const receiptFieldsWrap = document.getElementById('rv-receipt-fields');
		const modalTitleEl = document.getElementById('rv-modal-title');

		const viewerModal = document.getElementById('rv-viewer-modal');
		const viewerCloseBtn = document.getElementById('rv-viewer-close');
		const viewerTitleEl = document.getElementById('rv-viewer-title');
		const viewerImage = document.getElementById('rv-viewer-image');
		const viewerPdf = document.getElementById('rv-viewer-pdf');

		if (!fileContainer || !sectionTabs.length || !categoryEl) return;

		const categoriesBySection = {
			companyDocuments: ['License', 'Contract', 'Certificate', 'Insurance', 'Other'],
			receipts: ['Purchase Receipt', 'Utility Payment', 'Salary Payment', 'Other'],
		};

		let currentSection = 'companyDocuments';
		const vaultViewStorageKey = 'ww_vault_view_mode';
		let currentView = (() => {
			const saved = String(localStorage.getItem(vaultViewStorageKey) || '').trim().toLowerCase();
			return saved === 'list' ? 'list' : 'grid';
		})();
		let files = [];
		let stagedFile = null;
		let viewerObjectUrl = '';

		const getPreviewUrl = (fileId) => `${API_BASE}/api/record-vault/${currentSection}/${encodeURIComponent(fileId)}/download`;
		const getDownloadUrl = (fileId) => `${API_BASE}/api/record-vault/${currentSection}/${encodeURIComponent(fileId)}/download?download=1`;

		const isImageType = (contentType) => ['image/jpeg', 'image/jpg', 'image/png'].includes(String(contentType || '').toLowerCase());

		const revokeViewerObjectUrl = () => {
			if (!viewerObjectUrl) return;
			try { URL.revokeObjectURL(viewerObjectUrl); } catch (_e) { /* ignore */ }
			viewerObjectUrl = '';
		};

		const closeViewerModal = () => {
			revokeViewerObjectUrl();
			if (viewerModal) viewerModal.style.display = 'none';
			if (viewerTitleEl) viewerTitleEl.textContent = 'Preview';
			if (viewerImage) {
				viewerImage.style.display = 'none';
				viewerImage.removeAttribute('src');
			}
			if (viewerPdf) {
				viewerPdf.style.display = 'none';
				viewerPdf.removeAttribute('src');
			}
		};

		const openViewerModal = async (file) => {
			if (!file || !viewerModal) return;
			revokeViewerObjectUrl();
			const fileName = String(file.fileName || 'Preview').trim() || 'Preview';
			const previewUrl = getPreviewUrl(file.fileId);

			let blob;
			try {
				const response = await fetch(previewUrl, { credentials: 'include', cache: 'no-store' });
				if (!response.ok) throw new Error(`Open failed (${response.status})`);
				blob = await response.blob();
			} catch (_e) {
				alert('Could not open this file in-app. Please try again.');
				return;
			}

			const resolvedType = String(file.contentType || blob.type || '').toLowerCase();
			const isImage = isImageType(resolvedType);
			viewerObjectUrl = URL.createObjectURL(blob);

			if (viewerTitleEl) viewerTitleEl.textContent = fileName;
			if (viewerImage) {
				viewerImage.style.display = isImage ? 'block' : 'none';
				if (isImage) {
					viewerImage.src = viewerObjectUrl;
					viewerImage.alt = fileName;
				}
			}
			if (viewerPdf) {
				viewerPdf.style.display = isImage ? 'none' : 'block';
				if (!isImage) viewerPdf.src = `${viewerObjectUrl}#toolbar=1&navpanes=0&view=FitH`;
			}
			viewerModal.style.display = 'flex';
		};

		const triggerFileDownload = async (file) => {
			if (!file) return;
			const downloadUrl = getDownloadUrl(file.fileId);
			try {
				const response = await fetch(downloadUrl, { credentials: 'include', cache: 'no-store' });
				if (!response.ok) throw new Error(`Download failed (${response.status})`);
				const blob = await response.blob();
				const objectUrl = URL.createObjectURL(blob);
				const anchor = document.createElement('a');
				anchor.href = objectUrl;
				anchor.download = String(file.storageFileName || file.fileName || 'download').trim() || 'download';
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
				setTimeout(() => {
					try { URL.revokeObjectURL(objectUrl); } catch (_e) { /* ignore */ }
				}, 2000);
			} catch (_e) {
				alert('Could not download this file. Please try again.');
			}
		};

		const formatBytes = (bytes) => {
			const value = Number(bytes || 0);
			if (!Number.isFinite(value) || value <= 0) return '0 KB';
			if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
			return `${Math.max(1, Math.round(value / 1024))} KB`;
		};

		const setView = (nextView) => {
			currentView = nextView === 'list' ? 'list' : 'grid';
			try { localStorage.setItem(vaultViewStorageKey, currentView); } catch (_e) { /* ignore */ }
			fileContainer.classList.toggle('is-list', currentView === 'list');
			if (viewGridBtn) viewGridBtn.classList.toggle('is-active', currentView === 'grid');
			if (viewListBtn) viewListBtn.classList.toggle('is-active', currentView === 'list');
		};

		const populateCategories = () => {
			const categories = categoriesBySection[currentSection] || ['Other'];
			categoryEl.innerHTML = `<option value="All">All Categories</option>${categories.map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('')}`;
			if (uploadCategoryEl) {
				uploadCategoryEl.innerHTML = categories.map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('');
				const preferredDefault = categories.includes('Other') ? 'Other' : (categories[0] || '');
				if (preferredDefault) uploadCategoryEl.value = preferredDefault;
			}
		};

		const renderFiles = () => {
			if (!files.length) {
				fileContainer.innerHTML = '';
				if (emptyState) emptyState.style.display = 'grid';
				return;
			}
			if (emptyState) emptyState.style.display = 'none';

			fileContainer.innerHTML = files.map((file) => {
				const isImage = isImageType(file.contentType);
				const fileName = escapeHtml(file.fileName || 'File');
				const uploadedBy = escapeHtml(file.uploadedBy || 'Unknown');
				const category = escapeHtml(file.category || 'Other');
				const dateLabel = formatDateDisplay(String((currentSection === 'receipts' ? (file.date || file.uploadDate) : file.uploadDate) || '').slice(0, 10));
				const notes = currentSection === 'receipts' && file.notes ? `<div class="rv-card-meta">Notes: ${escapeHtml(file.notes)}</div>` : '';
				const amount = currentSection === 'receipts' && file.amount ? `<div class="rv-card-meta">Amount: ${escapeHtml(file.amount)}</div>` : '';
				return `
					<article class="rv-card" data-rv-file-id="${escapeHtml(file.fileId || '')}">
						<div class="rv-thumb">
							${isImage
								? `<img src="${getPreviewUrl(file.fileId)}" alt="${fileName}" loading="lazy">`
								: '<i class="fa-regular fa-file-pdf rv-file-icon" aria-hidden="true"></i>'}
						</div>
						<div class="rv-card-info">
							<div class="rv-card-title">${fileName}</div>
							<div class="rv-card-meta">Category: ${category}</div>
							<div class="rv-card-meta">Date: ${escapeHtml(dateLabel)}</div>
							<div class="rv-card-meta">Uploaded by: ${uploadedBy}</div>
							<div class="rv-card-meta">File size: ${escapeHtml(formatBytes(file.fileSize))}</div>
							${amount}
							${notes}
						</div>
						<div class="rv-card-actions">
							<button type="button" class="btn-secondary" data-rv-action="open"><i class="fa-regular fa-eye"></i> Open</button>
							<button type="button" class="btn-secondary" data-rv-action="download"><i class="fa-solid fa-download"></i> Download</button>
							<button type="button" class="btn-delete" data-rv-action="delete"><i class="fa-solid fa-trash"></i> Delete</button>
						</div>
					</article>
				`;
			}).join('');
		};

		const buildQuery = () => {
			const params = new URLSearchParams();
			if (searchEl && searchEl.value.trim()) params.set('search', searchEl.value.trim());
			if (categoryEl && categoryEl.value && categoryEl.value !== 'All') params.set('category', categoryEl.value);
			if (dateFromEl && dateFromEl.value) params.set('dateFrom', dateFromEl.value);
			if (dateToEl && dateToEl.value) params.set('dateTo', dateToEl.value);
			return params.toString();
		};

		const loadFiles = async () => {
			try {
				const query = buildQuery();
				const url = `${API_BASE}/api/record-vault/${currentSection}${query ? `?${query}` : ''}`;
				const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
				if (!res.ok) throw new Error('Failed to load files');
				const payload = await res.json();
				files = Array.isArray(payload.files) ? payload.files : [];
				renderFiles();
			} catch (_e) {
				files = [];
				renderFiles();
			}
		};

		const closeUploadModal = () => {
			if (uploadModal) uploadModal.style.display = 'none';
			stagedFile = null;
			if (selectedFileEl) {
				selectedFileEl.style.display = 'none';
				selectedFileEl.textContent = '';
			}
			if (fileInput) fileInput.value = '';
			if (uploadCategoryEl) {
				const categories = categoriesBySection[currentSection] || ['Other'];
				const preferredDefault = categories.includes('Other') ? 'Other' : (categories[0] || '');
				if (preferredDefault) uploadCategoryEl.value = preferredDefault;
			}
			if (uploadFileNameEl) uploadFileNameEl.value = '';
			if (uploadAmountEl) uploadAmountEl.value = '';
			if (uploadDateEl) uploadDateEl.value = '';
			if (uploadNotesEl) uploadNotesEl.value = '';
		};

		const openUploadModal = () => {
			if (modalTitleEl) modalTitleEl.textContent = currentSection === 'companyDocuments' ? 'Upload Company Document' : 'Upload Receipt / Payment';
			if (receiptFieldsWrap) receiptFieldsWrap.style.display = currentSection === 'receipts' ? 'block' : 'none';
			if (uploadModal) uploadModal.style.display = 'flex';
		};

		const stageFile = (file) => {
			if (!file) return;
			const allowed = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
			if (!allowed.includes(String(file.type || '').toLowerCase())) {
				alert('Only PDF, JPG, and PNG files are allowed.');
				return;
			}
			if (Number(file.size || 0) > 15 * 1024 * 1024) {
				alert('File must be 15MB or smaller.');
				return;
			}
			stagedFile = file;
			if (uploadFileNameEl && !String(uploadFileNameEl.value || '').trim()) {
				const nameBase = String(file.name || '').replace(/\.[^/.]+$/, '').trim();
				const titleCase = String(nameBase || String(file.name || '').trim())
					.toLowerCase()
					.replace(/[_-]+/g, ' ')
					.replace(/\s+/g, ' ')
					.trim()
					.replace(/\b\w/g, (m) => m.toUpperCase());
				uploadFileNameEl.value = titleCase;
			}
			if (selectedFileEl) {
				selectedFileEl.style.display = 'block';
				selectedFileEl.textContent = `Selected: ${file.name} (${formatBytes(file.size)})`;
			}
		};

		const submitUpload = async () => {
			if (!stagedFile) {
				alert('Please select a file to upload.');
				return;
			}
			if (uploadSubmitBtn) {
				uploadSubmitBtn.disabled = true;
				uploadSubmitBtn.textContent = 'Uploading...';
			}
			try {
				const formData = new FormData();
				formData.append('file', stagedFile);
				if (uploadFileNameEl && String(uploadFileNameEl.value || '').trim()) {
					formData.append('fileName', String(uploadFileNameEl.value || '').trim());
				}
				formData.append('category', uploadCategoryEl ? uploadCategoryEl.value : 'Other');
				formData.append('uploadedBy', (window.__wwCurrentUser && window.__wwCurrentUser.name) || localStorage.getItem('ww_user_name') || 'Unknown');
				if (currentSection === 'receipts') {
					formData.append('amount', uploadAmountEl ? uploadAmountEl.value : '');
					formData.append('date', uploadDateEl ? uploadDateEl.value : '');
					formData.append('notes', uploadNotesEl ? uploadNotesEl.value : '');
				}
				const res = await fetch(`${API_BASE}/api/record-vault/${currentSection}/upload`, {
					method: 'POST',
					credentials: 'include',
					body: formData,
				});
				if (!res.ok) {
					let message = 'Upload failed.';
					try {
						const payload = await res.json();
						if (payload && payload.message) message = String(payload.message);
					} catch (_jsonErr) {
						message = `Upload failed (HTTP ${res.status}).`;
					}
					throw new Error(message);
				}
				closeUploadModal();
				await loadFiles();
			} catch (error) {
				alert(error && error.message ? error.message : 'Upload failed. Please try again.');
			} finally {
				if (uploadSubmitBtn) {
					uploadSubmitBtn.disabled = false;
					uploadSubmitBtn.textContent = 'Upload';
				}
			}
		};

		sectionTabs.forEach((tab) => {
			tab.addEventListener('click', () => {
				const nextSection = tab.getAttribute('data-rv-section') || 'companyDocuments';
				if (!categoriesBySection[nextSection]) return;
				currentSection = nextSection;
				sectionTabs.forEach((btn) => btn.classList.toggle('tab-active', btn === tab));
				populateCategories();
				loadFiles();
			});
		});

		if (searchEl) searchEl.addEventListener('input', () => loadFiles());
		if (categoryEl) categoryEl.addEventListener('change', () => loadFiles());
		if (dateFromEl) dateFromEl.addEventListener('change', () => loadFiles());
		if (dateToEl) dateToEl.addEventListener('change', () => loadFiles());
		if (viewGridBtn) viewGridBtn.addEventListener('click', () => setView('grid'));
		if (viewListBtn) viewListBtn.addEventListener('click', () => setView('list'));
		if (uploadOpenBtn) uploadOpenBtn.addEventListener('click', openUploadModal);
		if (uploadModalClose) uploadModalClose.addEventListener('click', closeUploadModal);
		if (uploadModalCancel) uploadModalCancel.addEventListener('click', closeUploadModal);
		if (uploadModal) {
			uploadModal.addEventListener('click', (event) => {
				if (event.target === uploadModal) closeUploadModal();
			});
		}
		if (uploadSubmitBtn) uploadSubmitBtn.addEventListener('click', submitUpload);
		if (viewerCloseBtn) viewerCloseBtn.addEventListener('click', closeViewerModal);
		if (viewerModal) {
			viewerModal.addEventListener('click', (event) => {
				if (event.target === viewerModal) closeViewerModal();
			});
		}

		if (dropzone && fileInput) {
			dropzone.addEventListener('click', () => fileInput.click());
			dropzone.addEventListener('dragover', (event) => {
				event.preventDefault();
				dropzone.classList.add('is-over');
			});
			dropzone.addEventListener('dragleave', (event) => {
				event.preventDefault();
				dropzone.classList.remove('is-over');
			});
			dropzone.addEventListener('drop', (event) => {
				event.preventDefault();
				dropzone.classList.remove('is-over');
				const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
				if (file) stageFile(file);
			});
			fileInput.addEventListener('change', () => {
				const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
				if (file) stageFile(file);
			});
		}

		fileContainer.addEventListener('click', async (event) => {
			const btn = event.target.closest('[data-rv-action]');
			if (!btn) return;
			event.preventDefault();
			event.stopPropagation();
			const card = btn.closest('[data-rv-file-id]');
			if (!card) return;
			const fileId = String(card.getAttribute('data-rv-file-id') || '');
			if (!fileId) return;
			const file = files.find((row) => String(row.fileId || '') === fileId);
			const action = btn.getAttribute('data-rv-action');
			if (action === 'open') {
				await openViewerModal(file);
				return;
			}
			if (action === 'download') {
				await triggerFileDownload(file);
				return;
			}
			if (action === 'delete') {
				if (!window.confirm('Delete this file? This cannot be undone.')) return;
				try {
					const res = await fetch(`${API_BASE}/api/record-vault/${currentSection}/${encodeURIComponent(fileId)}`, {
						method: 'DELETE',
						credentials: 'include',
					});
					if (!res.ok) throw new Error('Delete failed');
					await loadFiles();
				} catch (_e) {
					alert('Could not delete this file.');
				}
			}
		});

		setView(currentView);
		populateCategories();
		loadFiles();
	}

function initProductionPage() {
	if (document.body.getAttribute('data-page') !== 'production') {
		return;
	}

	/* ---- BOM data (localStorage) ---- */
	const BOM_KEY = 'ww_bom_data';
	let billOfMaterials = {};
	try {
		const stored = JSON.parse(localStorage.getItem(BOM_KEY));
		if (stored && typeof stored === 'object' && !Array.isArray(stored)) billOfMaterials = stored;
	} catch (_) { /* ignore */ }
	function saveBom() { localStorage.setItem(BOM_KEY, JSON.stringify(billOfMaterials)); syncToServer(BOM_KEY, billOfMaterials); }
	/* ---- Production Batches (localStorage) ---- */
	const BATCH_KEY = 'ww_production_batches';
	let prodBatches = [];
	try {
		const stored = JSON.parse(localStorage.getItem(BATCH_KEY));
		if (Array.isArray(stored)) prodBatches = stored;
	} catch (_) { /* ignore */ }
	function saveBatches() {
		localStorage.setItem(BATCH_KEY, JSON.stringify(prodBatches));
		syncToServer(BATCH_KEY, prodBatches);
		/* Sync daily production log from batches (dashboard reads this) */
		const dailyLog = {};
		for (const b of prodBatches) {
			if (b.status !== 'completed') continue;
			const d = b.date || getTodayDateStr();
			dailyLog[d] = (dailyLog[d] || 0) + (Number(b.qty) || 0);
		}
		localStorage.setItem('ww_daily_production', JSON.stringify(dailyLog));
		syncToServer('ww_daily_production', dailyLog);
		/* Sync finished products from completed batches (inventory reads this) */
		const existing = (() => { try { return JSON.parse(localStorage.getItem('ww_finished_products') || '[]'); } catch(_) { return []; } })();
		const nonBatch = existing.filter((p) => !p._fromBatch);
		const fromBatch = prodBatches.filter((b) => b.status === 'completed').map((b, i) => ({
			id: 'BATCH-' + (i + 1),
			product: b.product,
			qty: b.qty,
			unitCost: b.qty > 0 ? +(b.cost / b.qty).toFixed(2) : 0,
			addedDate: b.date,
			_fromBatch: true,
		}));
		const mergedProducts = [...nonBatch, ...fromBatch];
		localStorage.setItem('ww_finished_products', JSON.stringify(mergedProducts));
		syncToServer('ww_finished_products', mergedProducts);
		/* Broadcast changes so other tabs (inventory, dashboard) refresh */
		try {
			const bc1 = new BroadcastChannel('ww_finished_products_sync');
			bc1.postMessage({ type: 'finished_products_updated' });
			bc1.close();
		} catch (_e) { /* fallback to storage event */ }
	}

	let batchCounter = prodBatches.length;
	function nextBatchId() {
		batchCounter++;
		return 'B-' + new Date().getFullYear() + '-' + String(batchCounter).padStart(3, '0');
	}

	/* Do NOT save during init — would overwrite server data with empty localStorage */
	// saveBatches();

	const todayStr = getTodayDateStr();

	function renderProductionPage() {
		/* Stats — auto-computed from batches + BOM */
		const todayBatches = prodBatches.filter((b) => b.date === todayStr);
		const totalBatches = prodBatches.length;
		const totalUnits = prodBatches.reduce((s, b) => s + b.qty, 0);
		const totalCost = prodBatches.reduce((s, b) => s + b.cost, 0);
		const totalSales = prodBatches.reduce((s, b) => s + (b.sales || 0), 0);
		const productCount = Object.keys(billOfMaterials).length;
		const stats = document.getElementById('prod-stats-row');
		if (stats) {
			stats.innerHTML = `
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-gears"></i></div><p class="s-label">Total Batches</p><p class="s-value">${totalBatches}</p><p class="s-meta">${todayBatches.length} today · ${productCount} product${productCount !== 1 ? 's' : ''}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-industry"></i></div><p class="s-label">Total Output</p><p class="s-value">${formatNumber(totalUnits)}</p><p class="s-meta">${formatNumber(todayBatches.reduce((s, b) => s + b.qty, 0))} units today</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-coins"></i></div><p class="s-label">Total Cost</p><p class="s-value">${formatCurrency(totalCost)}</p><p class="s-meta">${totalBatches > 0 ? 'Avg ' + formatCurrency(totalCost / totalBatches) + '/batch' : 'No batches'}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-chart-line"></i></div><p class="s-label">Profit / Loss</p><p class="s-value">${formatCurrency(totalSales - totalCost)}</p><p class="s-meta">Sales ${formatCurrency(totalSales)} · Cost ${formatCurrency(totalCost)}</p></div>
			`;
		}

		/* Batch table */
		const batchBody = document.getElementById('batches-tbody');
		if (batchBody) {
			const batchDraft = getBatchDraft();
			const batchDraftRow = batchDraft ? `<tr class="draft-row"><td>—</td><td>${escapeHtml(batchDraft.product || 'Unsaved batch')}</td><td>${escapeHtml(batchDraft.qty || '')}</td><td>${escapeHtml(batchDraft.date || '')}</td><td>${escapeHtml(batchDraft.shift || '')}</td><td>${escapeHtml(batchDraft.time || '')}</td><td>${escapeHtml(batchDraft.cost || '')}</td><td><span class="badge badge-orange">Draft</span></td><td><div class="row-actions"><button class="btn-edit prod-resume-draft-btn" title="Continue Draft"><i class="fa-solid fa-pen"></i></button><button class="btn-delete prod-clear-draft-btn" title="Discard Draft"><i class="fa-solid fa-trash"></i></button></div></td></tr>` : '';
			batchBody.innerHTML = batchDraftRow + (prodBatches.length === 0
				? '<tr><td colspan="9" style="text-align:center;color:#94a3b8;">No batches yet. Click "Add Batch" to start.</td></tr>'
				: prodBatches.map((b, idx) => {
					const pillClass = b.status === 'completed' ? 'status-green' : b.status === 'in-progress' ? 'status-blue' : 'status-orange';
					return `<tr><td>${b.id}</td><td>${b.product}</td><td>${formatNumber(b.qty)}</td><td>${b.date}</td><td>${b.shift}</td><td>${b.time}</td><td>${formatCurrency(b.cost)}</td><td><span class="status-pill ${pillClass}">${b.status}</span></td><td><div class="row-actions"><button class="btn-edit prod-edit-batch" data-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete prod-delete-batch" data-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
				}).join(''));
		}

		/* Daily summary cards */
		const dailySummary = document.getElementById('batch-daily-summary');
		if (dailySummary) {
			/* Group by date */
			const byDate = {};
			prodBatches.forEach((b) => {
				if (!byDate[b.date]) byDate[b.date] = { count: 0, units: 0, cost: 0 };
				byDate[b.date].count++;
				byDate[b.date].units += b.qty;
				byDate[b.date].cost += b.cost;
			});
			const dates = Object.keys(byDate).sort().reverse().slice(0, 7);
			dailySummary.innerHTML = dates.length === 0
				? ''
				: '<h4 style="margin:0 0 8px;font-size:0.85rem;color:#64748b;text-transform:uppercase;">Batches Per Day (last 7 days)</h4>' +
				  dates.map((d) => {
					const day = byDate[d];
					return `<div class="cashbook-card" style="text-align:left;display:flex;justify-content:space-between;align-items:center;"><div><p class="cb-label" style="margin:0">${d}</p><p style="margin:2px 0 0;font-size:0.78rem;color:#64748b;">${formatNumber(day.units)} units · ${formatCurrency(day.cost)}</p></div><p class="cb-val" style="margin:0">${day.count} batch${day.count !== 1 ? 'es' : ''}</p></div>`;
				  }).join('');
		}
	}
	renderProductionPage();

	/* ---- Batch Add Modal ---- */
	const batchModal = document.getElementById('batch-add-modal');
	const batchForm = document.getElementById('batch-add-form');
	const batchFields = document.getElementById('batch-modal-fields');
	const batchModalClose = document.getElementById('batch-modal-close');
	const batchAddBtn = document.getElementById('batch-add-btn');

	let editBatchIdx = -1;

	/* ── Production batch draft helpers ── */
	const BATCH_DRAFT_KEY = 'ww_prod_batch_draft';
	const getBatchDraft = () => { try { return JSON.parse(localStorage.getItem(BATCH_DRAFT_KEY)); } catch (_e) { return null; } };
	const clearBatchDraft = () => { localStorage.removeItem(BATCH_DRAFT_KEY); };
	const saveBatchDraft = () => {
		if (!batchFields || editBatchIdx >= 0) return;
		const fd = new FormData(batchForm);
		const data = {};
		['product', 'qty', 'date', 'shift', 'time', 'cost', 'sales', 'status'].forEach((k) => { const v = fd.get(k); if (v !== null) data[k] = v; });
		localStorage.setItem(BATCH_DRAFT_KEY, JSON.stringify(data));
	};
	const restoreBatchDraft = (draft) => {
		if (!draft || !batchFields) return;
		['product', 'qty', 'date', 'time', 'cost', 'sales'].forEach((k) => {
			const el = batchFields.querySelector(`[name="${k}"]`);
			if (el && draft[k] !== undefined) el.value = draft[k];
		});
		['shift', 'status'].forEach((k) => {
			const el = batchFields.querySelector(`[name="${k}"]`);
			if (el && draft[k] !== undefined) el.value = draft[k];
		});
	};
	const bindBatchDraftListeners = () => {
		if (!batchFields) return;
		batchFields.querySelectorAll('input, select').forEach((el) => {
			el.addEventListener('input', saveBatchDraft, { passive: true });
		});
	};

	function openBatchModal(editIdx, resumeDraft = false) {
		if (!batchModal || !batchFields) return;
		editBatchIdx = typeof editIdx === 'number' ? editIdx : -1;
		const b = editBatchIdx >= 0 ? prodBatches[editBatchIdx] : null;
		batchFields.innerHTML = `
			<div class="inv-modal-field"><label>Product</label><input type="text" name="product" value="${b ? b.product : 'Mobile Water 500ml'}" required></div>
			<div class="inv-modal-field"><label>Quantity</label><input type="number" name="qty" min="1" value="${b ? b.qty : ''}" required></div>
			<div class="inv-modal-field"><label>Date</label><input type="date" name="date" value="${b ? b.date : todayStr}" required></div>
			<div class="inv-modal-field"><label>Shift</label><select name="shift"><option value="Morning"${b && b.shift === 'Morning' ? ' selected' : ''}>Morning</option><option value="Afternoon"${b && b.shift === 'Afternoon' ? ' selected' : ''}>Afternoon</option><option value="Night"${b && b.shift === 'Night' ? ' selected' : ''}>Night</option></select></div>
			<div class="inv-modal-field"><label>Start Time</label><input type="time" name="time" value="${b ? b.time : '06:00'}" required></div>
			<div class="inv-modal-field"><label>Cost (GH₵)</label><input type="number" name="cost" min="0" step="0.01" value="${b ? b.cost : ''}" required></div>
			<div class="inv-modal-field"><label>Sales Value (GH₵)</label><input type="number" name="sales" min="0" step="0.01" value="${b ? (b.sales || '') : ''}" placeholder="Revenue from this batch" required></div>
			<div class="inv-modal-field"><label>Status</label><select name="status"><option value="completed"${b && b.status === 'completed' ? ' selected' : ''}>Completed</option><option value="in-progress"${b && b.status === 'in-progress' ? ' selected' : ''}>In Progress</option><option value="planned"${b && b.status === 'planned' ? ' selected' : ''}>Planned</option></select></div>
		`;
		if (resumeDraft) restoreBatchDraft(getBatchDraft());
		batchModal.style.display = 'flex';
		bindBatchDraftListeners();
	}

	if (batchAddBtn) batchAddBtn.addEventListener('click', () => openBatchModal(undefined, false));
	const closeBatchModal = () => {
		const wasAdding = editBatchIdx < 0;
		if (wasAdding) saveBatchDraft();
		if (batchModal) batchModal.style.display = 'none';
		if (wasAdding) { renderProductionPage(); renderProfitabilityChart(); }
	};
	if (batchModalClose) batchModalClose.addEventListener('click', closeBatchModal);
	if (batchModal) batchModal.addEventListener('click', (e) => { if (e.target === batchModal) closeBatchModal(); });
	window.addEventListener('beforeunload', () => { if (editBatchIdx < 0 && batchModal && batchModal.style.display === 'flex') saveBatchDraft(); });

	if (batchForm) {
		batchForm.addEventListener('submit', (e) => {
			e.preventDefault();
			const fd = new FormData(batchForm);
			const product = (fd.get('product') || '').toString().trim();
			if (!product) return;
			const data = {
				product,
				qty: parseInt(fd.get('qty')) || 0,
				date: fd.get('date') || todayStr,
				shift: fd.get('shift') || 'Morning',
				time: fd.get('time') || '06:00',
				cost: parseFloat(fd.get('cost')) || 0,
				sales: parseFloat(fd.get('sales')) || 0,
				status: fd.get('status') || 'completed',
			};
			if (editBatchIdx >= 0 && prodBatches[editBatchIdx]) {
				Object.assign(prodBatches[editBatchIdx], data);
			} else {
				data.id = nextBatchId();
				prodBatches.push(data);
			}
			saveBatches();
			clearBatchDraft();
			batchModal.style.display = 'none';
			editBatchIdx = -1;
			renderProductionPage();
			renderProfitabilityChart();
		});
	}

	/* Production edit/delete click handlers */
	document.addEventListener('click', (event) => {
		const resumeBtn = event.target.closest('.prod-resume-draft-btn');
		if (resumeBtn) { event.stopPropagation(); openBatchModal(undefined, true); return; }
		const clearBtn = event.target.closest('.prod-clear-draft-btn');
		if (clearBtn) {
			event.stopPropagation();
			clearBatchDraft();
			renderProductionPage();
			renderProfitabilityChart();
			return;
		}
		const editBtn = event.target.closest('.prod-edit-batch');
		if (editBtn) { openBatchModal(Number(editBtn.dataset.idx)); return; }
		const deleteBtn = event.target.closest('.prod-delete-batch');
		if (deleteBtn) {
			if (!window.confirm('Delete this batch? This cannot be undone.')) return;
			const batchIdx = Number(deleteBtn.dataset.idx);
			const removedBatch = prodBatches[batchIdx];
			if (removedBatch) moveAppDataDeleteToTrash('production', removedBatch, { kind: 'appDataArray', key: 'ww_production_batches' });
			prodBatches.splice(batchIdx, 1);
			saveBatches();
			renderProductionPage();
			renderProfitabilityChart();
			showDeleteToast(`Production batch ${removedBatch ? removedBatch.batchId || ('#' + (batchIdx + 1)) : ''} deleted.`);
			return;
		}
		const editComp = event.target.closest('.bom-edit-comp');
		if (editComp && selectedProduct && billOfMaterials[selectedProduct]) {
			const idx = Number(editComp.dataset.idx);
			const comp = billOfMaterials[selectedProduct].components[idx];
			if (!comp) return;
			openCompModal(idx);
			return;
		}
		const deleteComp = event.target.closest('.bom-delete-comp');
		if (deleteComp && selectedProduct && billOfMaterials[selectedProduct]) {
			if (!window.confirm('Delete this component?')) return;
			const compIdx = Number(deleteComp.dataset.idx);
			const removedComp = billOfMaterials[selectedProduct].components[compIdx];
			if (removedComp) {
				moveAppDataDeleteToTrash('production', removedComp, { kind: 'bomComponent', key: 'ww_bom_data', product: selectedProduct });
			}
			billOfMaterials[selectedProduct].components.splice(compIdx, 1);
			saveBom();
			renderBom(selectedProduct);
			showDeleteToast(`BOM component "${removedComp ? removedComp.material || removedComp.name || 'item' : 'item'}" removed.`);
			renderCostAnalysis();
		}
	});

	const selector = document.getElementById('bom-product-selector');
	const bomTitle = document.getElementById('bom-product-title');
	const bomBody = document.getElementById('bom-tbody');
	const bomSummary = document.getElementById('bom-cost-summary');
	let selectedProduct = Object.keys(billOfMaterials)[0];

	function renderBom(productName) {
		selectedProduct = productName;
		const product = billOfMaterials[productName];
		if (!product) {
			if (bomTitle) bomTitle.textContent = 'Bill of Materials';
			if (bomBody) bomBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#94a3b8;">No products yet. Click "+ Add Product" on the left to start.</td></tr>';
			if (bomSummary) bomSummary.innerHTML = '';
			return;
		}

		if (bomTitle) {
			bomTitle.textContent = `${productName} BOM`;
		}
		if (bomBody) {
			bomBody.innerHTML = product.components.length === 0
				? '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No components yet. Click "Add Component" below.</td></tr>'
				: product.components.map((c, idx) => {
					return `<tr><td>${c.name}</td><td>${formatNumber(c.qty)}</td><td>${c.unit}</td><td>${formatCurrency(c.cost)}</td><td><div class="row-actions"><button class="btn-edit bom-edit-comp" data-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete bom-delete-comp" data-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
				}).join('');
		}
		if (bomSummary) {
			const matTotal = product.components.reduce((sum, c) => sum + c.cost, 0);
			const total = matTotal + product.labor + product.overhead;
			bomSummary.innerHTML = `
				<div class="detail-row"><span class="detail-key">Materials</span><span class="detail-val">${formatCurrency(matTotal)}</span></div>
				<div class="detail-row"><span class="detail-key">Labor</span><span class="detail-val">${formatCurrency(product.labor)}</span></div>
				<div class="detail-row"><span class="detail-key">Overhead</span><span class="detail-val">${formatCurrency(product.overhead)}</span></div>
				<div class="line-total"><span>Total Production Cost</span><span>${formatCurrency(total)}</span></div>
			`;
		}

		if (selector) {
			selector.querySelectorAll('.product-btn').forEach((btn) => {
				btn.classList.toggle('btn-active', btn.getAttribute('data-product') === selectedProduct);
			});
		}
	}

	function rebuildProductSelector() {
		const productNames = Object.keys(billOfMaterials);
		if (!selectedProduct || !billOfMaterials[selectedProduct]) selectedProduct = productNames[0];
		if (selector) {
			selector.innerHTML = productNames.map((name) => {
				return `<button type="button" class="product-btn ${name === selectedProduct ? 'btn-active' : ''}" data-product="${name}">${name}</button>`;
			}).join('') + '<button type="button" class="product-btn btn-add-product" id="bom-add-product-btn" style="border:2px dashed #94a3b8;color:#64748b;"><i class="fa-solid fa-plus"></i> Add Product</button>';
			selector.querySelectorAll('.product-btn:not(.btn-add-product)').forEach((btn) => {
				btn.addEventListener('click', () => {
					renderBom(btn.getAttribute('data-product'));
				});
			});
			const addBtn = document.getElementById('bom-add-product-btn');
			if (addBtn) addBtn.addEventListener('click', openProductModal);
		}
		if (selectedProduct) renderBom(selectedProduct);
	}

	/* ---- Add Product Modal ---- */
	const prodModal = document.getElementById('product-add-modal');
	const prodForm = document.getElementById('product-add-form');
	const prodFields = document.getElementById('product-modal-fields');
	const prodModalClose = document.getElementById('product-modal-close');

	function openProductModal() {
		if (!prodModal || !prodFields) return;
		prodFields.innerHTML = `
			<div class="inv-modal-field"><label>Product Name <span class="req">*</span></label><input type="text" name="name" placeholder="e.g. Mobile Water 1.5L" required></div>
			<p style="margin:6px 0 2px;font-size:0.78rem;font-weight:600;color:#64748b;text-transform:uppercase;">Components (comma-separated rows: name, qty, unit, cost)</p>
			<div class="inv-modal-field"><label>Component 1</label><input type="text" name="comp1" placeholder="Preforms, 5000, pcs, 1200"></div>
			<div class="inv-modal-field"><label>Component 2</label><input type="text" name="comp2" placeholder="Caps, 5200, pcs, 312"></div>
			<div class="inv-modal-field"><label>Component 3</label><input type="text" name="comp3" placeholder="Label Rolls, 18, rolls, 612"></div>
			<div class="inv-modal-field"><label>Component 4</label><input type="text" name="comp4" placeholder="Shrink Wrap, 40, kg, 320"></div>
			<div class="inv-modal-field"><label>Labor Cost (GH₵)</label><input type="number" name="labor" min="0" step="0.01" value="0" required></div>
			<div class="inv-modal-field"><label>Overhead Cost (GH₵)</label><input type="number" name="overhead" min="0" step="0.01" value="0" required></div>
		`;
		prodModal.style.display = 'flex';
	}

	if (prodModalClose) prodModalClose.addEventListener('click', () => { prodModal.style.display = 'none'; });
	if (prodModal) prodModal.addEventListener('click', (e) => { if (e.target === prodModal) prodModal.style.display = 'none'; });

	if (prodForm) {
		prodForm.addEventListener('submit', (e) => {
			e.preventDefault();
			const fd = new FormData(prodForm);
			const name = (fd.get('name') || '').toString().trim();
			if (!name) return;
			const components = [];
			for (let i = 1; i <= 4; i++) {
				const raw = (fd.get('comp' + i) || '').toString().trim();
				if (!raw) continue;
				const parts = raw.split(',').map((s) => s.trim());
				if (parts.length >= 4) {
					components.push({ name: parts[0], qty: parseFloat(parts[1]) || 0, unit: parts[2], cost: parseFloat(parts[3]) || 0 });
				}
			}
			billOfMaterials[name] = {
				components,
				labor: parseFloat(fd.get('labor')) || 0,
				overhead: parseFloat(fd.get('overhead')) || 0,
			};
			saveBom();
			prodModal.style.display = 'none';
			selectedProduct = name;
			rebuildProductSelector();
			renderCostAnalysis();
			renderProductionPage();
		});
	}

	rebuildProductSelector();

	/* ---- Add Component to selected product ---- */
	const compModal = document.getElementById('bom-comp-modal');
	const compForm = document.getElementById('bom-comp-form');
	const compFields = document.getElementById('bom-comp-fields');
	const compModalClose = document.getElementById('bom-comp-modal-close');
	const compModalTitle = document.getElementById('bom-comp-modal-title');
	const compAddBtn = document.getElementById('bom-add-component-btn');

	let editCompIdx = -1;

	function openCompModal(editIdx) {
		if (!compModal || !compFields || !selectedProduct) return;
		editCompIdx = typeof editIdx === 'number' ? editIdx : -1;
		const comp = editCompIdx >= 0 && billOfMaterials[selectedProduct] ? billOfMaterials[selectedProduct].components[editCompIdx] : null;
		if (compModalTitle) compModalTitle.textContent = (comp ? 'Edit' : 'Add') + ' Component — ' + selectedProduct;
		compFields.innerHTML = `
			<div class="inv-modal-field"><label>Component Name <span class="req">*</span></label><input type="text" name="name" value="${comp ? comp.name : ''}" placeholder="e.g. Preforms" required></div>
			<div class="inv-modal-field"><label>Quantity</label><input type="number" name="qty" min="0" value="${comp ? comp.qty : ''}" required></div>
			<div class="inv-modal-field"><label>Unit</label><input type="text" name="unit" value="${comp ? comp.unit : ''}" placeholder="pcs, kg, rolls…" required></div>
			<div class="inv-modal-field"><label>Cost (GH₵)</label><input type="number" name="cost" min="0" step="0.01" value="${comp ? comp.cost : ''}" required></div>
		`;
		compModal.style.display = 'flex';
	}

	if (compAddBtn) compAddBtn.addEventListener('click', () => openCompModal());
	if (compModalClose) compModalClose.addEventListener('click', () => { compModal.style.display = 'none'; });
	if (compModal) compModal.addEventListener('click', (e) => { if (e.target === compModal) compModal.style.display = 'none'; });

	if (compForm) {
		compForm.addEventListener('submit', (e) => {
			e.preventDefault();
			if (!selectedProduct || !billOfMaterials[selectedProduct]) return;
			const fd = new FormData(compForm);
			const name = (fd.get('name') || '').toString().trim();
			if (!name) return;
			const data = {
				name,
				qty: parseFloat(fd.get('qty')) || 0,
				unit: (fd.get('unit') || '').toString().trim(),
				cost: parseFloat(fd.get('cost')) || 0,
			};
			if (editCompIdx >= 0 && billOfMaterials[selectedProduct].components[editCompIdx]) {
				Object.assign(billOfMaterials[selectedProduct].components[editCompIdx], data);
			} else {
				billOfMaterials[selectedProduct].components.push(data);
			}
			saveBom();
			compModal.style.display = 'none';
			editCompIdx = -1;
			renderBom(selectedProduct);
			renderCostAnalysis();
			renderProductionPage();
		});
	}

	/* Cost Analysis — auto-computed from BOM data across all products */
	function renderCostAnalysis() {
		let totalMat = 0, totalLabor = 0, totalOverhead = 0;
		Object.values(billOfMaterials).forEach((p) => {
			totalMat += p.components.reduce((s, c) => s + c.cost, 0);
			totalLabor += p.labor || 0;
			totalOverhead += p.overhead || 0;
		});
		const grand = totalMat + totalLabor + totalOverhead;
		const costData = grand > 0
			? [
				{ label: 'Raw Materials', value: Math.round((totalMat / grand) * 100), amount: totalMat, color: '#22c55e' },
				{ label: 'Labor', value: Math.round((totalLabor / grand) * 100), amount: totalLabor, color: '#3b82f6' },
				{ label: 'Overhead', value: Math.round((totalOverhead / grand) * 100), amount: totalOverhead, color: '#ef4444' },
			]
			: [
				{ label: 'Raw Materials', value: 0, amount: 0, color: '#22c55e' },
				{ label: 'Labor', value: 0, amount: 0, color: '#3b82f6' },
				{ label: 'Overhead', value: 0, amount: 0, color: '#ef4444' },
			];
		const cbEl = document.getElementById('cost-breakdown-bars');
		if (!cbEl) return;
		if (typeof Chart !== 'undefined' && grand > 0) {
			cbEl.innerHTML = '<canvas id="prod-cost-canvas" style="max-width:220px;max-height:220px;margin:0 auto;"></canvas>';
			const cbCtx = document.getElementById('prod-cost-canvas');
			if (window.__prodCostChart) window.__prodCostChart.destroy();
			window.__prodCostChart = new Chart(cbCtx, {
				type: 'doughnut',
				data: {
					labels: costData.map((c) => c.label),
					datasets: [{ data: costData.map((c) => c.value), backgroundColor: costData.map((c) => c.color), borderWidth: 2, borderColor: '#fff' }],
				},
				options: {
					responsive: true,
					maintainAspectRatio: true,
					plugins: {
						legend: { display: true, position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
						tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}% (${formatCurrency(costData[ctx.dataIndex].amount)})` } },
					},
				},
			});
		} else {
			renderProgressBars(cbEl, costData.map((c) => ({ label: c.label, value: c.value, color: c.color === '#22c55e' ? 'green' : c.color === '#3b82f6' ? 'blue' : 'red' })));
		}
	}
	renderCostAnalysis();

	/* Profitability by Batch — auto-computed from batch data */
	function renderProfitabilityChart() {
		const chartEl = document.getElementById('chart-profitability');
		if (!chartEl) return;
		if (prodBatches.length === 0) {
			chartEl.innerHTML = '<p style="text-align:center;color:#94a3b8;padding:20px 0;">No batches yet. Add batches to see profitability.</p>';
			return;
		}
		const rows = prodBatches.slice(-10).map((b) => ({
			label: b.id,
			revenue: b.sales || 0,
			cost: b.cost || 0,
		}));
		if (typeof Chart !== 'undefined') {
			chartEl.innerHTML = '<canvas id="prod-profit-canvas"></canvas>';
			const pfCtx = document.getElementById('prod-profit-canvas');
			if (window.__prodProfitChart) window.__prodProfitChart.destroy();
			window.__prodProfitChart = new Chart(pfCtx, {
				type: 'bar',
				data: {
					labels: rows.map((r) => r.label),
					datasets: [
						{ label: 'Sales', data: rows.map((r) => r.revenue), backgroundColor: 'rgba(22,163,74,0.7)', borderColor: '#16a34a', borderWidth: 1, borderRadius: 6 },
						{ label: 'Cost', data: rows.map((r) => r.cost), backgroundColor: 'rgba(245,158,11,0.7)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 6 },
					],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { mode: 'index', intersect: false },
					plugins: {
						legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
						tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}` } },
					},
					scales: { y: { beginAtZero: true, ticks: { callback: (v) => formatCurrency(v) } } },
				},
			});
		} else {
			renderDualBars(chartEl, rows.map((r) => ({ month: r.label, revenue: r.revenue, cost: r.cost })));
		}
	}
	renderProfitabilityChart();

	/* ── Cross-tab sync: refresh production when another tab changes batches ── */
	const reloadProductionData = () => {
		try {
			const stored = JSON.parse(localStorage.getItem(BATCH_KEY));
			if (Array.isArray(stored)) prodBatches = stored;
		} catch (_) { /* ignore */ }
		try {
			const stored = JSON.parse(localStorage.getItem(BOM_KEY));
			if (stored && typeof stored === 'object' && !Array.isArray(stored)) billOfMaterials = stored;
		} catch (_) { /* ignore */ }
		renderProductionPage();
		rebuildProductSelector();
		renderCostAnalysis();
		renderProfitabilityChart();
	};
	window.addEventListener('storage', (e) => {
		if ([BATCH_KEY, BOM_KEY, 'ww_finished_products', 'ww_daily_production'].includes(e.key)) {
			reloadProductionData();
		}
	});
	try {
		new BroadcastChannel('ww_finished_products_sync').onmessage = reloadProductionData;
	} catch (_e) { /* BroadcastChannel not supported */ }
	document.addEventListener('ww-refresh-page', renderProductionPage);
}

function initReportsPage() {
	if (document.body.getAttribute('data-page') !== 'reports') {
		return;
	}

	// ── Set up filter controls ──
	const filterType = document.getElementById('rep-filter-type');
	const filterMonth = document.getElementById('rep-filter-month');
	const filterYear = document.getElementById('rep-filter-year');

	if (filterMonth) {
		const now = new Date();
		filterMonth.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	}

	// Populate year dropdown from all data
	if (filterYear) {
		const allDates = [];
		const sd = getAllSalesData();
		sd.invoices.forEach((i) => { const d = new Date(i.date); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		sd.salesOrders.forEach((o) => { const d = new Date(o.orderDate); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		const ad = JSON.parse(localStorage.getItem('ww_accounting_data_v2') || '{"ledger":[]}');
		ad.ledger.forEach((e) => { const d = new Date(e.date); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		const bd = JSON.parse(localStorage.getItem('ww_production_batches') || '[]');
		bd.forEach((b) => { const d = new Date(b.date); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		const pd = JSON.parse(localStorage.getItem('ww_purchase_data_v2') || '{"purchaseOrders":[]}');
		(pd.purchaseOrders || []).forEach((po) => { const d = new Date(po.date); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		const years = [...new Set(allDates)].sort((a, b) => b - a);
		if (years.length === 0) years.push(new Date().getFullYear());
		filterYear.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
	}

	if (filterType) {
		filterType.addEventListener('change', () => {
			if (filterMonth) filterMonth.style.display = filterType.value === 'month' ? '' : 'none';
			if (filterYear) filterYear.style.display = filterType.value === 'year' ? '' : 'none';
		});
	}

	renderReportsData();

	// ── Cross-tab sync: auto-refresh reports when data changes ──
	if (!window.__wwReportsStorageBound) {
		window.__wwReportsStorageBound = true;
		window.addEventListener('storage', (event) => {
			const watchKeys = ['ww_accounting_data_v2', 'ww_production_batches', 'ww_purchase_data_v2', 'ww_raw_materials', 'ww_equipment', 'ww_cost_centre_budgets'];
			if (watchKeys.includes(event.key) || (event.key && event.key.startsWith('ww_sales_'))) {
				renderReportsData();
			}
		});
		const channels = ['ww_sales_sync', 'ww_accounting_sync', 'ww_purchase_sync'];
		for (const ch of channels) {
			try {
				const bc = new BroadcastChannel(ch);
				bc.onmessage = () => renderReportsData();
			} catch (_e) { /* ignore */ }
		}
	}
	document.addEventListener('ww-refresh-page', renderReportsData);
}

window.exportReports = function () {
	const main = document.querySelector('.ops-main');
	if (!main) {
		alert('Nothing to export on this page yet.');
		return;
	}

	const title = 'White Water Wells - Reports';
	const stamp = new Date().toLocaleString('en-GB');
	const exportHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #fff; color: #0f172a; }
    .export-wrap { padding: 20px; }
    .export-head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #e2e8f0; margin-bottom: 12px; padding-bottom: 8px; }
    .export-head h1 { font-size: 1.1rem; margin: 0; }
    .export-head p { font-size: 0.85rem; color: #64748b; margin: 0; }
    .ops-sidebar, .ops-topbar, .logout-link, .btn-print, .tab-bar button, .btn-edit, .btn-delete, .rep-budget-btn, .modal-backdrop { display: none !important; }
    .panel, .stat-card, .kpi-card-v2, .data-table, .chart-wrap { break-inside: avoid; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="export-wrap">
    <div class="export-head">
      <h1>${title}</h1>
      <p>Generated: ${stamp}</p>
    </div>
    ${main.innerHTML}
  </div>
</body>
</html>`;

	/* Always trigger a download — works regardless of popup blocker */
	const blob = new Blob([exportHtml], { type: 'text/html;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `reports-export-${new Date().toISOString().slice(0, 10)}.html`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);

	/* Also open a print preview if the browser allows it */
	try {
		const printWin = window.open('', '_blank', 'width=1100,height=900');
		if (printWin && printWin.document) {
			printWin.document.open();
			printWin.document.write(exportHtml);
			printWin.document.close();
			setTimeout(() => { try { printWin.focus(); printWin.print(); } catch (_e) { /* ignored */ } }, 350);
		}
	} catch (_e) { /* popup blocked — download already triggered above */ }
};

window.applyReportsFilter = function () {
	const filterType = document.getElementById('rep-filter-type');
	const filterMonth = document.getElementById('rep-filter-month');
	const filterYear = document.getElementById('rep-filter-year');
	if (filterMonth) filterMonth.style.display = filterType && filterType.value === 'month' ? '' : 'none';
	if (filterYear) filterYear.style.display = filterType && filterType.value === 'year' ? '' : 'none';
	renderReportsData();
};

function renderReportsData() {
	// ── Determine date range from filter ──
	const filterType = (document.getElementById('rep-filter-type') || {}).value || 'all';
	let filterStart = null;
	let filterEnd = null;
	let filterLabel = 'All Time';

	const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	if (filterType === 'month') {
		const val = (document.getElementById('rep-filter-month') || {}).value || '';
		if (val) {
			const [y, m] = val.split('-').map(Number);
			filterStart = new Date(y, m - 1, 1);
			filterEnd = new Date(y, m, 0, 23, 59, 59, 999);
			filterLabel = `${monthNames[m - 1]} ${y}`;
		}
	} else if (filterType === 'year') {
		const val = Number((document.getElementById('rep-filter-year') || {}).value);
		if (val) {
			filterStart = new Date(val, 0, 1);
			filterEnd = new Date(val, 11, 31, 23, 59, 59, 999);
			filterLabel = String(val);
		}
	}

	function inRange(dateStr) {
		if (!filterStart) return true;
		const d = new Date(dateStr);
		if (isNaN(d)) return false;
		return d >= filterStart && d <= filterEnd;
	}

	// ── Pull real data from localStorage ──
	const salesData = getAllSalesData();
	const accData = JSON.parse(localStorage.getItem('ww_accounting_data_v2') || '{"ledger":[],"cashbook":[],"summary":[],"currencies":[]}');
	const allBatches = JSON.parse(localStorage.getItem('ww_production_batches') || '[]');
	const purchaseData = JSON.parse(localStorage.getItem('ww_purchase_data_v2') || '{"purchaseOrders":[],"suppliers":[]}');
	const rawMaterials = JSON.parse(localStorage.getItem('ww_raw_materials') || '[]');
	const equipment = JSON.parse(localStorage.getItem('ww_equipment') || '[]');
	const finishedProducts = JSON.parse(localStorage.getItem('ww_finished_products') || '[]');

	// Filter by date range
	const invoices = salesData.invoices.filter((i) => inRange(i.date));
	const orders = salesData.salesOrders.filter((o) => inRange(o.orderDate));
	const ledger = accData.ledger.filter((e) => inRange(e.date));
	const cashbook = accData.cashbook.filter((e) => inRange(e.date));
	const batches = allBatches.filter((b) => inRange(b.date));
	const purchaseOrders = (purchaseData.purchaseOrders || []).filter((po) => inRange(po.date));

	// For the invoice count KPI: when filtering by month also count bucket invoices
	// with no date (they are invisible to inRange but do belong to the month bucket).
	let filteredInvoiceCount = invoices.length;
	if (filterType === 'month' && filterStart) {
		const bucketKey = `${filterStart.getFullYear()}-${String(filterStart.getMonth() + 1).padStart(2, '0')}`;
		const bucketPayload = getSalesMonthPayload(bucketKey);
		const bucketInvs = Array.isArray(bucketPayload && bucketPayload.invoices) ? bucketPayload.invoices : [];
		const dateFilteredIds = new Set(invoices.map((i) => String(i.id)));
		filteredInvoiceCount += bucketInvs.filter((i) => i && i.id && !dateFilteredIds.has(String(i.id))).length;
	}

	// ── Sales Trends: aggregate invoices by month (revenue + bags + promo, paid only) ──
	const salesByMonth = {};
	for (const month of recoverSalesMonthsFromStorage()) {
		if (!/^\d{4}-\d{2}$/.test(month)) continue;
		if (!inRange(`${month}-01`)) continue;
		salesByMonth[month] = salesByMonth[month] || { sales: 0, units: 0, promo: 0 };
	}
	for (const inv of invoices) {
		if (inv.status !== 'paid') continue;
		const d = new Date(inv.date);
		if (isNaN(d)) continue;
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
		if (!salesByMonth[key]) salesByMonth[key] = { sales: 0, units: 0, promo: 0 };
		salesByMonth[key].sales += Number(inv.amount) || 0;
		salesByMonth[key].units += Number(inv.items && inv.items[0] ? inv.items[0].qty : 0) || 0;
		salesByMonth[key].promo += Number(inv.promo) || 0;
	}
	const salesTrends = Object.keys(salesByMonth).sort().slice(-12).map((key) => {
		const monthIdx = parseInt(key.split('-')[1], 10) - 1;
		return { month: monthNames[monthIdx], sales: salesByMonth[key].sales, units: salesByMonth[key].units, promo: salesByMonth[key].promo };
	});

	// ── P&L from filtered sales + accounting + production + purchase data ──
	const salesRevenue = invoices.filter((inv) => inv.status === 'paid').reduce((s, inv) => s + (Number(inv.amount) || 0), 0);
	const promoExpense = invoices.filter((inv) => inv.status === 'paid').reduce((s, inv) => {
		const rate = Number(inv.rate || (inv.items && inv.items[0] ? inv.items[0].unitPrice : 0) || 0);
		return s + (Number(inv.promo || 0) * rate);
	}, 0);
	const ledgerRevenue = ledger.filter((e) => e.type === 'revenue').reduce((s, e) => s + ((Number(e.credit) || 0) - (Number(e.debit) || 0)), 0);
	const filteredSummaryRevenue = salesRevenue + ledgerRevenue;
	const filteredSummaryExpenses = ledger.filter((e) => e.type === 'expense').reduce((s, e) => s + ((Number(e.debit) || 0) - (Number(e.credit) || 0)), 0);
	const cogs = batches.reduce((s, b) => s + (Number(b.cost) || 0), 0);
	const purchaseSpend = purchaseOrders.reduce((s, po) => {
		const amt = (po.items && po.items.length) ? po.items.reduce((t, i) => t + ((Number(i.qty) || 0) * (Number(i.unitCost) || 0)), 0) : (Number(po.amount) || 0);
		return s + amt;
	}, 0);
	const netProfit = filteredSummaryRevenue - cogs - filteredSummaryExpenses - purchaseSpend - promoExpense;
	const profitLoss = [
		{ item: 'Sales Revenue', amount: salesRevenue },
		{ item: 'Other Revenue', amount: ledgerRevenue },
		{ item: 'Cost of Goods Sold', amount: cogs ? -cogs : 0 },
		{ item: 'Purchase Orders', amount: purchaseSpend ? -purchaseSpend : 0 },
		{ item: 'Operating Expenses', amount: filteredSummaryExpenses ? -filteredSummaryExpenses : 0 },
		{ item: 'Promotional Expense', amount: promoExpense ? -promoExpense : 0 },
		{ item: 'Net Profit', amount: netProfit },
	];

	// ── Cost Centre Performance from filtered ledger ──
	const centreBuckets = { Production: 0, Transport: 0, Maintenance: 0, Utilities: 0, Administration: 0, Salaries: 0, Marketing: 0 };
	for (const entry of ledger) {
		if (entry.type !== 'expense') continue;
		const acc = (entry.account || '').toLowerCase();
		if (acc.includes('production') || acc.includes('manufactur') || acc.includes('factory')) {
			centreBuckets.Production += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('transport') || acc.includes('logistics') || acc.includes('delivery') || acc.includes('shipping')) {
			centreBuckets.Transport += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('maintenance')) {
			centreBuckets.Maintenance += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('utilities') || acc.includes('electric')) {
			centreBuckets.Utilities += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('salar') || acc.includes('wage')) {
			centreBuckets.Salaries += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('marketing') || acc.includes('advertis')) {
			centreBuckets.Marketing += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else {
			centreBuckets.Administration += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		}
	}
	const costCentrePerformance = Object.entries(centreBuckets)
		.filter(([, actual]) => actual !== 0)
		.map(([centre, actual]) => ({ centre, budget: 0, actual }));

	// ── Inventory Distribution (not date-filtered — shows current snapshot) ──
	const rawCount = rawMaterials.length;
	const equipCount = equipment.length;
	const finCount = finishedProducts.length;
	const invTotal = rawCount + equipCount + finCount;
	const inventoryReport = invTotal > 0 ? [
		{ label: 'Raw Materials', value: Math.round((rawCount / invTotal) * 100), color: '#3b82f6' },
		{ label: 'Equipment', value: Math.round((equipCount / invTotal) * 100), color: '#f59e0b' },
		{ label: 'Finished Goods', value: Math.round((finCount / invTotal) * 100), color: '#22c55e' },
	].filter((seg) => seg.value > 0) : [];

	// ── Daily Shift Sales from filtered batches ──
	const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const shiftBuckets = {};
	for (const b of batches) {
		const d = new Date(b.date);
		if (isNaN(d)) continue;
		const dayKey = d.toISOString().slice(0, 10);
		if (!shiftBuckets[dayKey]) shiftBuckets[dayKey] = { morning: 0, afternoon: 0, night: 0 };
		const shift = (b.shift || '').toLowerCase();
		const val = Number(b.sales) || 0;
		if (shift.includes('morning')) shiftBuckets[dayKey].morning += val;
		else if (shift.includes('afternoon')) shiftBuckets[dayKey].afternoon += val;
		else shiftBuckets[dayKey].night += val;
	}
	const dailyShiftSales = Object.keys(shiftBuckets).sort().slice(-7).map((dayKey) => {
		const d = new Date(dayKey);
		return { day: dayLabels[d.getDay()], ...shiftBuckets[dayKey] };
	});

	// ── Production Performance Over Time (Daily/Monthly toggle + pan/zoom timeline) ──
	const perfHost = document.getElementById('chart-production-performance');
	const perfRangeWrap = document.getElementById('rep-performance-ranges');
	const perfViewWrap = document.getElementById('rep-performance-views');
	if (perfHost) {
		const DAY_MS = 24 * 60 * 60 * 1000;
		const fmtLong = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
		const fmtMonth = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });

		const parseDateStartMs = (raw) => {
			const text = String(raw || '').trim();
			if (!text) return null;
			// Accept both date-only values (YYYY-MM-DD) and full datetime strings.
			const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
				? new Date(text + 'T00:00:00')
				: new Date(text);
			if (Number.isNaN(date.getTime())) return null;
			date.setHours(0, 0, 0, 0);
			return date.getTime();
		};

		const monthStartMs = (ms) => {
			const d = new Date(ms);
			d.setHours(0, 0, 0, 0);
			d.setDate(1);
			return d.getTime();
		};

		const monthAverageOutput = (monthRows) => {
			if (!Array.isArray(monthRows) || !monthRows.length) return 0;
			const total = monthRows.reduce((sum, row) => sum + Number(row.output || 0), 0);
			return total / monthRows.length;
		};

		const zoneForOutput = (output) => getProductionZoneInfo(output);

		const addMonthsStartMs = (ms, count) => {
			const d = new Date(ms);
			d.setHours(0, 0, 0, 0);
			d.setDate(1);
			d.setMonth(d.getMonth() + count);
			return d.getTime();
		};

		const allInvoiceRows = Array.isArray(getAllSalesData().invoices) ? getAllSalesData().invoices : [];
		const outputStartMs = allInvoiceRows
			.map((row) => parseDateStartMs(row && row.date))
			.filter((ms) => Number.isFinite(ms))
			.sort((a, b) => a - b)[0];

		if (!Number.isFinite(outputStartMs)) {
			perfHost.innerHTML = '<p style="color:#64748b;text-align:center;padding:48px 0">No output history found yet.</p>';
		} else if (typeof Chart === 'undefined') {
			perfHost.innerHTML = '<p style="color:#64748b;text-align:center;padding:48px 0">Chart library unavailable.</p>';
		} else {
			const dailyByDate = new Map();
			const ensureDay = (ms) => {
				if (!dailyByDate.has(ms)) dailyByDate.set(ms, { output: 0, dispatches: 0, revenue: 0 });
				return dailyByDate.get(ms);
			};

			const invoiceDateMs = (inv, fallbackMonthKey) => {
				const explicit = parseDateStartMs(inv && inv.date);
				if (Number.isFinite(explicit)) return explicit;
				if (/^\d{4}-\d{2}$/.test(String(fallbackMonthKey || ''))) {
					return parseDateStartMs(`${fallbackMonthKey}-01`);
				}
				return null;
			};

			// Build a deduped invoice set from both merged sales data and per-month AppData buckets
			// so records with missing explicit dates still contribute using their month bucket.
			const perfInvoicesById = new Map();
			for (const inv of getAllSalesData().invoices) {
				if (!inv || !inv.id) continue;
				const idKey = String(inv.id);
				const monthKey = /^\d{4}-\d{2}$/.test(String(inv.month || '')) ? String(inv.month) : null;
				const dateMs = invoiceDateMs(inv, monthKey);
				if (!Number.isFinite(dateMs)) continue;
				perfInvoicesById.set(idKey, { inv, monthKey, dateMs });
			}
			for (const monthKey of recoverSalesMonthsFromStorage()) {
				if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) continue;
				const payload = getSalesMonthPayload(monthKey);
				const monthInvoices = Array.isArray(payload && payload.invoices) ? payload.invoices : [];
				for (const inv of monthInvoices) {
					if (!inv || !inv.id) continue;
					const idKey = String(inv.id);
					const dateMs = invoiceDateMs(inv, monthKey);
					if (!Number.isFinite(dateMs)) continue;
					const existing = perfInvoicesById.get(idKey);
					const existingHasExplicitDate = existing && Number.isFinite(parseDateStartMs(existing.inv && existing.inv.date));
					const incomingHasExplicitDate = Number.isFinite(parseDateStartMs(inv && inv.date));
					if (!existing || (!existingHasExplicitDate && incomingHasExplicitDate)) {
						perfInvoicesById.set(idKey, { inv, monthKey, dateMs });
					}
				}
			}

			for (const { inv, dateMs } of perfInvoicesById.values()) {
				const row = ensureDay(dateMs);
				row.output += getInvoiceOutputBags(inv);
				row.dispatches += 1;
				if (String(inv && inv.status || '').toLowerCase() === 'paid') {
					row.revenue += Number(inv && inv.amount || 0) || 0;
				}
			}

			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const endMs = today.getTime();
			const startMonthMs = monthStartMs(outputStartMs);
			const endMonthMs = monthStartMs(endMs);

			const dailyRows = [];
			for (let ms = outputStartMs; ms <= endMs; ms += DAY_MS) {
				const row = dailyByDate.get(ms) || { output: 0, dispatches: 0, revenue: 0 };
				dailyRows.push({ x: ms, output: row.output, dispatches: row.dispatches, revenue: row.revenue });
			}

			const monthlyByStart = new Map();
			for (const row of dailyRows) {
				const key = monthStartMs(row.x);
				const bucket = monthlyByStart.get(key) || { x: key, outputTotal: 0, dispatches: 0, revenue: 0, dayCount: 0 };
				bucket.outputTotal += row.output;
				bucket.dispatches += row.dispatches;
				bucket.revenue += row.revenue;
				bucket.dayCount += 1;
				monthlyByStart.set(key, bucket);
			}
			const monthlyRows = [];
			for (let ms = startMonthMs; ms <= endMonthMs; ms = addMonthsStartMs(ms, 1)) {
				const bucket = monthlyByStart.get(ms) || { x: ms, outputTotal: 0, dispatches: 0, revenue: 0, dayCount: 0 };
				const daysInMonth = bucket.dayCount || new Date(new Date(ms).getFullYear(), new Date(ms).getMonth() + 1, 0).getDate();
				monthlyRows.push({
					x: ms,
					output: daysInMonth > 0 ? (bucket.outputTotal / daysInMonth) : 0,
					dispatches: bucket.dispatches,
					revenue: bucket.revenue,
				});
			}

			const dataByView = { daily: dailyRows, monthly: monthlyRows };
			let currentView = 'daily';
			let viewMin = Math.max(outputStartMs, endMs - (29 * DAY_MS));
			let viewMax = endMs;
			let currentZoneBands = [];

			const labelForX = (ms) => {
				if (currentView === 'monthly') return fmtMonth.format(new Date(ms));
				return fmtLong.format(new Date(ms));
			};

			const setActivePerfRangeBtn = (rangeKey) => {
				if (!perfRangeWrap) return;
				perfRangeWrap.querySelectorAll('.rep-range-btn').forEach((btn) => {
					btn.classList.toggle('is-active', String(btn.getAttribute('data-range')) === String(rangeKey));
				});
			};

			const setActivePerfViewBtn = (viewKey) => {
				if (!perfViewWrap) return;
				perfViewWrap.querySelectorAll('.rep-view-btn').forEach((btn) => {
					btn.classList.toggle('is-active', String(btn.getAttribute('data-view')) === String(viewKey));
				});
			};

			const updateRangeButtonLabels = () => {
				if (!perfRangeWrap) return;
				const map = currentView === 'monthly'
					? { '30d': 'Last 3M', '90d': '6M', '1y': '12M', 'all': 'All' }
					: { '30d': 'Last 30D', '90d': '90D', '1y': '1Y', 'all': 'All' };
				perfRangeWrap.querySelectorAll('.rep-range-btn').forEach((btn) => {
					const key = String(btn.getAttribute('data-range') || '');
					if (map[key]) btn.textContent = map[key];
				});
			};

			const rangeToWindow = (rangeKey) => {
				if (currentView === 'monthly') {
					if (rangeKey === 'all') return { min: startMonthMs, max: endMonthMs };
					if (rangeKey === '1y') return { min: Math.max(startMonthMs, addMonthsStartMs(endMonthMs, -11)), max: endMonthMs };
					if (rangeKey === '90d') return { min: Math.max(startMonthMs, addMonthsStartMs(endMonthMs, -5)), max: endMonthMs };
					return { min: Math.max(startMonthMs, addMonthsStartMs(endMonthMs, -2)), max: endMonthMs };
				}
				if (rangeKey === 'all') return { min: outputStartMs, max: endMs };
				if (rangeKey === '1y') return { min: Math.max(outputStartMs, endMs - (364 * DAY_MS)), max: endMs };
				if (rangeKey === '90d') return { min: Math.max(outputStartMs, endMs - (89 * DAY_MS)), max: endMs };
				return { min: Math.max(outputStartMs, endMs - (29 * DAY_MS)), max: endMs };
			};

			const currentRows = () => dataByView[currentView] || [];

			const buildZoneBands = () => {
				const rows = currentRows();
				return rows.map((row) => {
					const zone = currentView === 'monthly' ? zoneForOutput(row.output) : zoneForOutput(row.output);
					return { x: row.x, zone };
				});
			};

			const paintZoneBands = (chart) => {
				if (!chart || !chart.ctx || !chart.chartArea || !Array.isArray(currentZoneBands) || !currentZoneBands.length) return;
				const { ctx, chartArea, scales } = chart;
				const xScale = scales.x;
				if (!xScale) return;
				ctx.save();
				const top = chartArea.top;
				const height = chartArea.bottom - chartArea.top;
				for (let i = 0; i < currentZoneBands.length; i += 1) {
					const band = currentZoneBands[i];
					const next = currentZoneBands[i + 1];
					const xStart = xScale.getPixelForValue(band.x);
					const xEnd = next ? xScale.getPixelForValue(next.x) : chartArea.right;
					ctx.fillStyle = band.zone.band;
					ctx.fillRect(Math.min(xStart, xEnd), top, Math.max(1, Math.abs(xEnd - xStart)), height);
				}
				ctx.restore();
			};

			const applyRangeWindow = (chart, rangeKey) => {
				if (!chart) return;
				const nextWindow = rangeToWindow(rangeKey);
				viewMin = nextWindow.min;
				viewMax = nextWindow.max;
				const rows = currentRows();
				currentZoneBands = buildZoneBands();
				chart.data.datasets[0].data = rows.map((row) => ({ x: row.x, y: row.output }));
				chart.data.datasets[1].data = rows.map((row) => ({ x: row.x, y: row.dispatches }));
				chart.data.datasets[2].data = rows.map((row) => ({ x: row.x, y: row.revenue }));
				chart.options.scales.x.min = viewMin;
				chart.options.scales.x.max = viewMax;
				chart.options.plugins.zoom.limits.x.min = currentView === 'monthly' ? startMonthMs : outputStartMs;
				chart.options.plugins.zoom.limits.x.max = currentView === 'monthly' ? endMonthMs : endMs;
				chart.options.plugins.zoom.limits.x.minRange = currentView === 'monthly' ? (27 * DAY_MS) : (7 * DAY_MS);
				chart.update('none');
				setActivePerfRangeBtn(rangeKey);
			};

			try {
				const zoomPlugin = window.ChartZoom || window['chartjs-plugin-zoom'];
				if (zoomPlugin && Chart.registry && Chart.registry.plugins && !Chart.registry.plugins.get('zoom')) {
					Chart.register(zoomPlugin);
				}
				if (!window.__wwProductionZoneBandPlugin) {
					window.__wwProductionZoneBandPlugin = {
						id: 'wwProductionZoneBands',
						beforeDraw(chart) {
							paintZoneBands(chart);
						},
					};
					Chart.register(window.__wwProductionZoneBandPlugin);
				}
			} catch (_e) {
				// Continue without explicit registration if unavailable.
			}

			perfHost.innerHTML = '<canvas id="rep-production-performance-canvas"></canvas>';
			const perfCtx = document.getElementById('rep-production-performance-canvas');
			if (window.__repProdPerfChart) window.__repProdPerfChart.destroy();

			window.__repProdPerfChart = new Chart(perfCtx, {
				type: 'line',
				data: {
					datasets: [
						{ label: 'Daily Output', data: [], borderColor: '#1d4ed8', backgroundColor: 'rgba(29, 78, 216, 0.12)', pointRadius: 0, pointHitRadius: 12, tension: 0.25, fill: true, yAxisID: 'y' },
						{ label: 'Dispatch Records', data: [], borderColor: '#16a34a', backgroundColor: 'rgba(22, 163, 74, 0.12)', pointRadius: 0, pointHitRadius: 12, tension: 0.25, fill: false, yAxisID: 'y' },
						{ label: 'Revenue (Paid)', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.12)', pointRadius: 0, pointHitRadius: 12, tension: 0.25, fill: false, yAxisID: 'yRevenue' },
					],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { mode: 'nearest', axis: 'x', intersect: false },
					plugins: {
						legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
						tooltip: {
							callbacks: {
								title: (items) => {
									const x = items && items[0] && items[0].parsed ? items[0].parsed.x : null;
									return Number.isFinite(x) ? labelForX(x) : '';
								},
								label: (ctx) => {
									if (ctx.dataset.label === 'Revenue (Paid)') return `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}`;
									return `${ctx.dataset.label}: ${formatNumber(ctx.parsed.y)}`;
								},
							},
						},
						zoom: {
							limits: { x: { min: outputStartMs, max: endMs, minRange: 7 * DAY_MS } },
							pan: { enabled: true, mode: 'x' },
							zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
							onPanComplete: () => setActivePerfRangeBtn('custom'),
							onZoomComplete: () => setActivePerfRangeBtn('custom'),
						},
					},
					scales: {
						x: {
							type: 'linear',
							min: viewMin,
							max: viewMax,
							ticks: {
								autoSkip: true,
								maxTicksLimit: 8,
								callback: (value) => labelForX(Number(value)),
							},
							grid: { color: 'rgba(148,163,184,0.16)' },
						},
						y: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: 'Daily Output / Dispatches', font: { size: 11 } }, ticks: { callback: (v) => formatNumber(v) }, grid: { color: 'rgba(148,163,184,0.16)' } },
						yRevenue: { type: 'linear', position: 'right', beginAtZero: true, title: { display: true, text: 'Revenue (GH₵)', font: { size: 11 } }, ticks: { callback: (v) => formatCurrency(v) }, grid: { drawOnChartArea: false } },
					},
				},
			});

			if (perfViewWrap && !perfViewWrap.__boundPerfView) {
				perfViewWrap.__boundPerfView = true;
				perfViewWrap.addEventListener('click', (event) => {
					const btn = event.target.closest('.rep-view-btn');
					if (!btn || !window.__repProdPerfChart) return;
					const viewKey = String(btn.getAttribute('data-view') || '').trim();
					if (viewKey !== 'daily' && viewKey !== 'monthly') return;
					currentView = viewKey;
					setActivePerfViewBtn(currentView);
					updateRangeButtonLabels();
					applyRangeWindow(window.__repProdPerfChart, currentView === 'monthly' ? '1y' : '30d');
				});
			}

			if (perfRangeWrap && !perfRangeWrap.__boundPerfRange) {
				perfRangeWrap.__boundPerfRange = true;
				perfRangeWrap.addEventListener('click', (event) => {
					const btn = event.target.closest('.rep-range-btn');
					if (!btn || !window.__repProdPerfChart) return;
					const rangeKey = String(btn.getAttribute('data-range') || '').trim();
					if (!rangeKey) return;
					applyRangeWindow(window.__repProdPerfChart, rangeKey);
				});
			}

			setActivePerfViewBtn('daily');
			updateRangeButtonLabels();
			applyRangeWindow(window.__repProdPerfChart, '30d');
		}
	}

	// ── KPI cards ──
	const allSalesTotal = salesTrends.reduce((s, r) => s + r.sales, 0);
	const latestSales = salesTrends.length > 0 ? salesTrends[salesTrends.length - 1].sales : 0;
	const projected = salesTrends.length >= 2
		? latestSales + Math.round((latestSales - salesTrends[0].sales) / salesTrends.length)
		: latestSales;

	const totalEquip = equipment.length;
	const operationalEquip = equipment.filter((e) => e.status === 'operational').length;
	const opsHealth = totalEquip > 0 ? Math.round((operationalEquip / totalEquip) * 100) : 100;

	const totalInvoicesAllTime = getAllSalesData().invoices.length;

	// ── Market Growth Rate KPI (filter-aware) ──
	const mgMonthly = (() => {
		const byMonth = {};
		for (const month of recoverSalesMonthsFromStorage()) {
			if (/^\d{4}-\d{2}$/.test(month)) byMonth[month] = byMonth[month] || 0;
		}
		for (const inv of getAllSalesData().invoices) {
			if (inv.status !== 'paid') continue;
			const d = new Date(inv.date);
			if (isNaN(d)) continue;
			const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
			byMonth[key] = (byMonth[key] || 0) + (Number(inv.amount) || 0);
		}
		return Object.keys(byMonth).sort().map((key) => {
			const [year, month] = key.split('-');
			return { key, year: Number(year), month: Number(month), value: byMonth[key] };
		});
	})();
	let mgGrowth = null;
	let mgMeta = '';
	if (filterType === 'month' && filterStart) {
		const y = filterStart.getFullYear();
		const m = filterStart.getMonth() + 1;
		const curKey = `${y}-${String(m).padStart(2, '0')}`;
		const prevDate = new Date(y, m - 2, 1);
		const prevKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
		const curRev = mgMonthly.find((r) => r.key === curKey)?.value || 0;
		const prevRev = mgMonthly.find((r) => r.key === prevKey)?.value || 0;
		if (prevRev > 0 && curRev > 0) { mgGrowth = ((curRev - prevRev) / prevRev) * 100; mgMeta = `${filterLabel} vs ${monthNames[prevDate.getMonth()]} ${prevDate.getFullYear()}`; }
		else { mgMeta = prevRev === 0 && curRev === 0 ? 'No data for period' : 'No prior month to compare'; }
	} else if (filterType === 'year' && filterStart) {
		const year = filterStart.getFullYear();
		const byYear = mgMonthly.reduce((acc, r) => { acc[r.year] = (acc[r.year] || 0) + r.value; return acc; }, {});
		const curRev = byYear[year] || 0;
		const prevRev = byYear[year - 1] || 0;
		if (prevRev > 0 && curRev > 0) { mgGrowth = ((curRev - prevRev) / prevRev) * 100; mgMeta = `${year} vs ${year - 1}`; }
		else { mgMeta = prevRev === 0 && curRev === 0 ? 'No data for period' : `No ${year - 1} data to compare`; }
	} else {
		if (mgMonthly.length >= 2) {
			const current = mgMonthly[mgMonthly.length - 1];
			const previous = mgMonthly[mgMonthly.length - 2];
			if (previous.value > 0 && current.value > 0) {
				mgGrowth = ((current.value - previous.value) / previous.value) * 100;
				mgMeta = `${current.key} vs ${previous.key}`;
			} else {
				mgMeta = 'No prior month to compare';
			}
		} else {
			mgMeta = 'Not enough data yet';
		}
	}
	const mgLabel = mgGrowth !== null ? `${mgGrowth >= 0 ? '+' : ''}${mgGrowth.toFixed(1)}%` : '—';
	const mgColor = mgGrowth === null ? '' : mgGrowth >= 0 ? 'green' : 'red';

	const kpis = [
		{ icon: '<i class="fa-solid fa-chart-bar"></i>', label: 'Sales (' + filterLabel + ')', value: formatCurrency(allSalesTotal), meta: filterType === 'all' ? 'All tracked sales' : 'Filtered period', color: '' },
		{ icon: '<i class="fa-solid fa-gift"></i>', label: 'Promo Expense (' + filterLabel + ')', value: formatCurrency(promoExpense), meta: promoExpense > 0 ? 'Free/discounted bags — marketing cost' : 'No promo this period', color: 'red' },
		{ icon: '<i class="fa-solid fa-chart-line"></i>', label: 'Forecast', value: formatCurrency(projected), meta: salesTrends.length >= 2 ? 'Trend-based projection' : 'Need more months', color: 'green' },
		{ icon: '<i class="fa-solid fa-coins"></i>', label: 'Net Profit', value: formatCurrency(netProfit), meta: 'Revenue − COGS − Expenses − Promo', color: 'yellow' },
		{ icon: '<i class="fa-solid fa-chart-line"></i>', label: 'Market Growth Rate', value: mgLabel, meta: mgMeta, color: mgColor },
		{ icon: '<i class="fa-solid fa-file-invoice"></i>', label: filterType === 'all' ? 'Total Invoices (All Time)' : `Total Invoices (${filterLabel})`, value: filterType === 'all' ? totalInvoicesAllTime.toLocaleString() : filteredInvoiceCount.toLocaleString(), meta: filterType === 'all' ? `${totalInvoicesAllTime} invoices overall` : `${filteredInvoiceCount} invoices in ${filterLabel}`, color: 'purple' },
		{ icon: '<i class="fa-solid fa-industry"></i>', label: 'Ops Health', value: `${opsHealth}%`, meta: totalEquip > 0 ? `${operationalEquip}/${totalEquip} equipment up` : 'No equipment tracked', color: '' },
	];

	const kpiGrid = document.getElementById('rep-kpi-grid');
	if (kpiGrid) {
		kpiGrid.innerHTML = kpis.map((kpi) => {
			return `
				<article class="kpi-card-v2 ${kpi.color}">
					<div class="kpi-icon">${kpi.icon}</div>
					<p class="kpi-label">${kpi.label}</p>
					<p class="kpi-value">${kpi.value}</p>
					<p class="kpi-meta">${kpi.meta}</p>
				</article>
			`;
		}).join('');
	}

	// ── Sales Trends chart (Chart.js with tooltips) ──
	const stEl = document.getElementById('chart-sales-trends');
	if (stEl && salesTrends.length > 0) {
		if (typeof Chart !== 'undefined') {
			stEl.innerHTML = '<canvas id="rep-sales-trends-canvas"></canvas>';
			const stCtx = document.getElementById('rep-sales-trends-canvas');
			if (window.__repSalesTrendChart) window.__repSalesTrendChart.destroy();
			window.__repSalesTrendChart = new Chart(stCtx, {
				type: 'bar',
				data: {
					labels: salesTrends.map((r) => r.month),
					datasets: [
						{
							label: 'Revenue',
							data: salesTrends.map((r) => r.sales),
							backgroundColor: 'rgba(22,163,74,0.7)',
							borderColor: '#16a34a',
							borderWidth: 1,
							borderRadius: 6,
							yAxisID: 'y',
						},
						{
							label: 'Bags Sold',
							data: salesTrends.map((r) => r.units),
							backgroundColor: 'rgba(37,99,235,0.6)',
							borderColor: '#1d4ed8',
							borderWidth: 1,
							borderRadius: 6,
							yAxisID: 'y1',
						},
						{
							label: 'Promo Bags',
							data: salesTrends.map((r) => r.promo),
							backgroundColor: 'rgba(245,158,11,0.6)',
							borderColor: '#f59e0b',
							borderWidth: 1,
							borderRadius: 6,
							yAxisID: 'y1',
						},
					],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { mode: 'index', intersect: false },
					plugins: {
						legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
						tooltip: {
							callbacks: {
								label: (ctx) => {
									if (ctx.dataset.label === 'Revenue') return `Revenue: ${formatCurrency(ctx.parsed.y)}`;
									if (ctx.dataset.label === 'Promo Bags') return `Promo Bags: ${formatNumber(ctx.parsed.y)}`;
									return `Bags Sold: ${formatNumber(ctx.parsed.y)}`;
								},
							},
						},
					},
					scales: {
						y: {
							type: 'linear',
							position: 'left',
							beginAtZero: true,
							ticks: { callback: (v) => formatCurrency(v) },
							title: { display: true, text: 'Revenue (GH₵)', font: { size: 11 } },
						},
						y1: {
							type: 'linear',
							position: 'right',
							beginAtZero: true,
							grid: { drawOnChartArea: false },
							ticks: { callback: (v) => formatNumber(v) },
							title: { display: true, text: 'Bags', font: { size: 11 } },
						},
					},
				},
			});
		} else {
			renderDualBars(stEl, salesTrends.map((row) => ({ month: row.month, revenue: row.sales, cost: row.units })));
		}
	} else if (stEl) {
		stEl.innerHTML = `<p style="color:#64748b;text-align:center;padding:40px 0">No sales data for ${filterLabel}.</p>`;
	}

	// ── Daily Shift Sales chart (Chart.js) ──
	const ssEl = document.getElementById('chart-shift-sales');
	if (ssEl && dailyShiftSales.length > 0) {
		if (typeof Chart !== 'undefined') {
			ssEl.innerHTML = '<canvas id="rep-shift-sales-canvas"></canvas>';
			const ssCtx = document.getElementById('rep-shift-sales-canvas');
			if (window.__repShiftChart) window.__repShiftChart.destroy();
			window.__repShiftChart = new Chart(ssCtx, {
				type: 'bar',
				data: {
					labels: dailyShiftSales.map((d) => d.day),
					datasets: [
						{ label: 'Morning', data: dailyShiftSales.map((d) => d.morning), backgroundColor: 'rgba(251,191,36,0.7)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 4 },
						{ label: 'Afternoon', data: dailyShiftSales.map((d) => d.afternoon), backgroundColor: 'rgba(37,99,235,0.7)', borderColor: '#1d4ed8', borderWidth: 1, borderRadius: 4 },
						{ label: 'Night', data: dailyShiftSales.map((d) => d.night), backgroundColor: 'rgba(100,116,139,0.7)', borderColor: '#475569', borderWidth: 1, borderRadius: 4 },
					],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { mode: 'index', intersect: false },
					plugins: {
						legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
						tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatNumber(ctx.parsed.y)}` } },
					},
					scales: {
						x: { stacked: true },
						y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => formatNumber(v) } },
					},
				},
			});
		} else {
			renderVerticalBars(ssEl, dailyShiftSales.map((day) => ({ label: day.day, value: day.morning + day.afternoon + day.night })), { color: 'linear-gradient(180deg,#38bdf8,#2563eb)', valueFormatter: (v) => formatNumber(v) });
		}
	} else if (ssEl) {
		ssEl.innerHTML = `<p style="color:#64748b;text-align:center;padding:40px 0">No batch data for ${filterLabel}.</p>`;
	}

	// ── Sales summary cards (from filtered sales data) ──
	const salesSummary = document.getElementById('sales-summary-cards');
	if (salesSummary) {
		// For order count and bags: use ALL invoices in the period (all statuses),
		// matching the invoices page which counts everything in the month bucket.
		// For month filter also include no-date invoices from that bucket so counts
		// align with the invoices page (which reads from the bucket, not by date).
		let allPeriodInvoices = invoices; // already date-filtered
		if (filterType === 'month' && filterStart) {
			// Also pull in invoices from the month bucket that have no date
			const bucketKey = `${filterStart.getFullYear()}-${String(filterStart.getMonth() + 1).padStart(2, '0')}`;
			const bucketPayload = getSalesMonthPayload(bucketKey);
			const bucketInvs = Array.isArray(bucketPayload && bucketPayload.invoices) ? bucketPayload.invoices : [];
			const dateFilteredIds = new Set(invoices.map((i) => String(i.id)));
			const extras = bucketInvs.filter((i) => i && i.id && !dateFilteredIds.has(String(i.id)));
			if (extras.length > 0) allPeriodInvoices = invoices.concat(extras);
		}

		let totalBags = 0, totalPromo = 0;
		const orderCount = allPeriodInvoices.filter((inv) => inv && inv.id).length;
		for (const inv of allPeriodInvoices) {
			if (!inv || !inv.id) continue;
			totalBags += Number(inv.items && inv.items[0] ? inv.items[0].qty : 0) || 0;
			totalPromo += Number(inv.promo) || 0;
		}
		const totalNonPromo = Math.max(0, totalBags - totalPromo);

		// Financial totals remain paid-only (use original date-filtered + paid subset)
		const allEntries = [];
		for (const inv of invoices) {
			if (inv.status !== 'paid') continue;
			const d = new Date(inv.date);
			if (isNaN(d)) continue;
			const amount = Number(inv.amount) || 0;
			const bags = Number(inv.items && inv.items[0] ? inv.items[0].qty : 0) || 0;
			const promo = Number(inv.promo) || 0;
			allEntries.push({ date: d, amount, bags, promo });
		}

		const totalSales = allEntries.reduce((s, e) => s + e.amount, 0);
		const paidCount = allEntries.length;
		const avgOrder = paidCount > 0 ? Math.round(totalSales / paidCount) : 0;

		if (filterType === 'all') {
			const now = new Date();
			const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
			const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
			const qDate = new Date(now); qDate.setMonth(qDate.getMonth() - 2);
			const quarterStart = new Date(qDate.getFullYear(), qDate.getMonth(), 1);
			const yearStart = new Date(now.getFullYear(), 0, 1);
			const weekTotal = allEntries.filter((e) => e.date >= weekAgo).reduce((s, e) => s + e.amount, 0);
			const monthTotal = allEntries.filter((e) => e.date >= monthStart).reduce((s, e) => s + e.amount, 0);
			const quarterTotal = allEntries.filter((e) => e.date >= quarterStart).reduce((s, e) => s + e.amount, 0);
			const yearTotal = allEntries.filter((e) => e.date >= yearStart).reduce((s, e) => s + e.amount, 0);
			salesSummary.innerHTML = `
				<div class="stat-card"><p class="s-label">Week Sales</p><p class="s-value">${formatCurrency(weekTotal)}</p><p class="s-meta">Last 7 days</p></div>
				<div class="stat-card"><p class="s-label">Month Sales</p><p class="s-value">${formatCurrency(monthTotal)}</p><p class="s-meta">${monthNames[now.getMonth()]} ${now.getFullYear()}</p></div>
				<div class="stat-card"><p class="s-label">Quarter Sales</p><p class="s-value">${formatCurrency(quarterTotal)}</p><p class="s-meta">Last 3 months</p></div>
				<div class="stat-card"><p class="s-label">Year Sales</p><p class="s-value">${formatCurrency(yearTotal)}</p><p class="s-meta">${now.getFullYear()} total</p></div>
				<div class="stat-card"><p class="s-label">Avg Order</p><p class="s-value">${formatCurrency(avgOrder)}</p><p class="s-meta">${orderCount} orders total</p></div>
				<div class="stat-card rep-bags-card"><div class="s-icon"><i class="fa-solid fa-bag-shopping"></i></div><p class="s-label">Bags Sold (All Time)</p><p class="s-value">${formatNumber(totalBags)}</p><p class="s-meta split-meta"><span>Non-promo: <strong>${formatNumber(totalNonPromo)}</strong> (${totalBags > 0 ? Math.round((totalNonPromo / totalBags) * 100) : 0}%)</span><span>Promo: <strong>${formatNumber(totalPromo)}</strong> (${totalBags > 0 ? Math.round((totalPromo / totalBags) * 100) : 0}%)</span></p></div>
			`;
		} else {
			salesSummary.innerHTML = `
				<div class="stat-card"><p class="s-label">Total Sales</p><p class="s-value">${formatCurrency(totalSales)}</p><p class="s-meta">${filterLabel}</p></div>
				<div class="stat-card"><p class="s-label">Orders</p><p class="s-value">${orderCount}</p><p class="s-meta">${filterLabel}</p></div>
				<div class="stat-card"><p class="s-label">Avg Order</p><p class="s-value">${formatCurrency(avgOrder)}</p><p class="s-meta">Per invoice/order</p></div>
				<div class="stat-card rep-bags-card"><div class="s-icon"><i class="fa-solid fa-bag-shopping"></i></div><p class="s-label">Bags Sold (${filterLabel})</p><p class="s-value">${formatNumber(totalBags)}</p><p class="s-meta split-meta"><span>Non-promo: <strong>${formatNumber(totalNonPromo)}</strong> (${totalBags > 0 ? Math.round((totalNonPromo / totalBags) * 100) : 0}%)</span><span>Promo: <strong>${formatNumber(totalPromo)}</strong> (${totalBags > 0 ? Math.round((totalPromo / totalBags) * 100) : 0}%)</span></p></div>
			`;
		}
	}

	// ── P&L table ──
	const plBody = document.getElementById('pl-tbody');
	if (plBody) {
		if (profitLoss.some((line) => line.amount !== 0)) {
			plBody.innerHTML = profitLoss.map((line) => {
				const cssClass = line.item === 'Net Profit' ? 'status-pill status-green' : '';
				return `<tr><td>${line.item}</td><td>${cssClass ? `<span class="${cssClass}">${formatCurrency(line.amount)}</span>` : formatCurrency(line.amount)}</td></tr>`;
			}).join('');
		} else {
			plBody.innerHTML = `<tr><td colspan="2" style="color:#64748b;text-align:center;padding:20px">No accounting data for ${filterLabel}.</td></tr>`;
		}
	}

	// ── Inventory pie chart (Chart.js doughnut) ──
	const totalInventory = inventoryReport.reduce((sum, segment) => sum + segment.value, 0);
	const pieContainer = document.getElementById('inventory-pie');
	if (pieContainer) {
		if (inventoryReport.length > 0 && totalInventory > 0 && typeof Chart !== 'undefined') {
			pieContainer.innerHTML = '<canvas id="rep-inventory-canvas" style="max-width:220px;max-height:220px;margin:0 auto;"></canvas>';
			const pieCtx = document.getElementById('rep-inventory-canvas');
			if (window.__repInvPieChart) window.__repInvPieChart.destroy();
			window.__repInvPieChart = new Chart(pieCtx, {
				type: 'doughnut',
				data: {
					labels: inventoryReport.map((s) => s.label),
					datasets: [{
						data: inventoryReport.map((s) => s.value),
						backgroundColor: inventoryReport.map((s) => s.color),
						borderWidth: 2,
						borderColor: '#fff',
					}],
				},
				options: {
					responsive: true,
					maintainAspectRatio: true,
					plugins: {
						legend: { display: false },
						tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}%` } },
					},
				},
			});
		} else if (inventoryReport.length > 0 && totalInventory > 0) {
			pieContainer.innerHTML = `
				<div style="width:170px;height:170px;border-radius:50%;background:conic-gradient(
					${inventoryReport.map((segment, index) => {
						const before = inventoryReport.slice(0, index).reduce((sum, s) => sum + s.value, 0);
						const start = (before / totalInventory) * 360;
						const end = ((before + segment.value) / totalInventory) * 360;
						return `${segment.color} ${start}deg ${end}deg`;
					}).join(',')}
				);
				border:8px solid #fff;box-shadow:0 4px 14px rgba(2,6,23,0.12);"></div>
			`;
		} else {
			pieContainer.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px 0">No inventory items tracked yet.</p>';
		}
	}
	const pieLegend = document.getElementById('inventory-pie-legend');
	if (pieLegend) {
		pieLegend.innerHTML = inventoryReport.map((segment) => {
			return `
				<div class="pie-legend-item">
					<span class="pie-swatch" style="background:${segment.color};"></span>
					<span>${segment.label} (${segment.value}%)</span>
				</div>
			`;
		}).join('');
	}

	// ── Cost Centre Performance table ──
	const budgets = JSON.parse(localStorage.getItem('ww_cost_centre_budgets') || '{}');
	const centreBody = document.getElementById('cost-centre-tbody');
	if (centreBody) {
		if (costCentrePerformance.length > 0) {
			centreBody.innerHTML = costCentrePerformance.map((centre) => {
				const bgt = budgets[centre.centre] || 0;
				centre.budget = bgt;
				const variance = centre.actual - bgt;
				const status = bgt === 0 ? 'no budget set' : variance <= 0 ? 'within budget' : variance < 300 ? 'watch' : 'over budget';
				const pillClass = bgt === 0 ? 'status-blue' : variance <= 0 ? 'status-green' : variance < 300 ? 'status-yellow' : 'status-red';
				return `
					<tr>
						<td>${centre.centre}</td>
						<td>${bgt ? formatCurrency(bgt) : '—'}</td>
						<td>${formatCurrency(centre.actual)}</td>
						<td>${bgt ? (variance >= 0 ? '+' : '') + formatCurrency(variance) : '—'}</td>
						<td><span class="status-pill ${pillClass}">${status}</span></td>
						<td><button class="btn-edit rep-budget-btn" data-centre="${centre.centre}" data-budget="${bgt}"><i class="fa-solid fa-pen-to-square"></i></button></td>
					</tr>
				`;
			}).join('');
		} else {
			centreBody.innerHTML = `<tr><td colspan="6" style="color:#64748b;text-align:center;padding:20px">No expense entries for ${filterLabel}.</td></tr>`;
		}
	}

	// Budget edit button handler
	if (centreBody && !centreBody.__budgetBound) {
		centreBody.__budgetBound = true;
		centreBody.addEventListener('click', (e) => {
			const btn = e.target.closest('.rep-budget-btn');
			if (!btn) return;
			const centre = btn.getAttribute('data-centre');
			const current = Number(btn.getAttribute('data-budget')) || 0;
			const modal = document.getElementById('budget-modal');
			document.getElementById('budget-modal-title').textContent = `Set Budget — ${centre}`;
			document.getElementById('budget-centre-key').value = centre;
			document.getElementById('budget-centre-name').value = centre;
			document.getElementById('budget-amount').value = current || '';
			modal.style.display = 'flex';
		});
	}

	// Budget form submit handler
	const budgetForm = document.getElementById('budget-form');
	if (budgetForm && !budgetForm.__bound) {
		budgetForm.__bound = true;
		budgetForm.addEventListener('submit', (e) => {
			e.preventDefault();
			const centre = document.getElementById('budget-centre-key').value;
			const amt = Number(document.getElementById('budget-amount').value) || 0;
			const stored = JSON.parse(localStorage.getItem('ww_cost_centre_budgets') || '{}');
			stored[centre] = amt;
			localStorage.setItem('ww_cost_centre_budgets', JSON.stringify(stored));
			syncToServer('ww_cost_centre_budgets', stored);
			document.getElementById('budget-modal').style.display = 'none';
			renderReportsData();
		});
	}

	// ── Ops metric cards (from filtered batches) ──
	const metricCards = document.getElementById('ops-metric-cards');
	if (metricCards) {
		const completedBatches = batches.filter((b) => b.status === 'completed').length;
		const totalBatches = batches.length;
		const efficiency = totalBatches > 0 ? Math.round((completedBatches / totalBatches) * 100) : 0;
		const lowStock = rawMaterials.filter((m) => m.quantity <= m.minLevel).length;
		metricCards.innerHTML = `
			<div class="metric-card"><span class="m-value">${totalBatches > 0 ? efficiency + '%' : '—'}</span><span class="m-label">Production Efficiency</span></div>
			<div class="metric-card"><span class="m-value">${lowStock}</span><span class="m-label">Stock Alerts</span></div>
			<div class="metric-card"><span class="m-value">${opsHealth}%</span><span class="m-label">Equipment Operational</span></div>
		`;
	}
}

function bindAuthPanels() {
	const toggles = document.querySelectorAll('[data-toggle-target]');
	if (!toggles.length) {
		return;
	}
	for (const toggle of toggles) {
		toggle.addEventListener('click', () => {
			const targetId = toggle.getAttribute('data-toggle-target');
			if (!targetId) {
				return;
			}
			const panel = document.getElementById(targetId);
			if (!panel) {
				return;
			}
			panel.hidden = !panel.hidden;
		});
	}
}

function setAuthMessage(message, isError) {
	const messageNode = document.getElementById('auth-message');
	if (!messageNode) {
		return;
	}
	const safeMessage = String(message || '').replace(/\bceo\b/gi, 'CEO');
	messageNode.textContent = safeMessage;
	if (isError) {
		messageNode.style.cssText = 'color:#b42318;background:#fef3f2;border:1px solid #fecdca;padding:10px 14px;border-radius:8px;font-weight:500;margin-top:12px;';
	} else {
		messageNode.style.cssText = 'color:#027a48;background:#ecfdf3;border:1px solid #a6f4c5;padding:10px 14px;border-radius:8px;font-weight:500;margin-top:12px;';
	}
}

async function postJson(url, payload) {
	let response;
	try {
		response = await fetch(API_BASE + url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(payload),
		});
	} catch (networkError) {
		throw new Error('Cannot reach server. Check your internet connection and try again.');
	}

	let data = {};
	try {
		data = await response.json();
	} catch (_error) {
		data = {};
	}

	if (!response.ok) {
		throw new Error(data.message || `Server error (${response.status})`);
	}
	return data;
}

function bindPasswordAssistanceForms() {
	const forgotForm = document.getElementById('forgot-password-form');
	const resetForm = document.getElementById('reset-password-form');

	if (forgotForm) {
		forgotForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			const formData = new FormData(forgotForm);
			const email = String(formData.get('email') || '').trim();
			try {
				const data = await postJson('/api/auth/forgot-password', { email });
				setAuthMessage(data.message || 'Password assistance sent.', false);
				forgotForm.reset();
				// Auto-open the reset password panel so user can proceed
				const forgotPanel = document.getElementById('forgot-password-panel');
				const resetPanel = document.getElementById('reset-password-panel');
				if (forgotPanel) forgotPanel.hidden = true;
				if (resetPanel) {
					resetPanel.hidden = false;
					resetPanel.scrollIntoView({ behavior: 'smooth' });
				}
			} catch (error) {
				setAuthMessage(error.message || 'Could not process request.', true);
			}
		});
	}

	if (resetForm) {
		resetForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			const formData = new FormData(resetForm);
			const email = String(formData.get('email') || '').trim();
			const currentPassword = String(formData.get('currentPassword') || '');
			const newPassword = String(formData.get('newPassword') || '');
			const confirmPassword = String(formData.get('confirmPassword') || '');

			if (!currentPassword) {
				setAuthMessage('Please enter your current password.', true);
				return;
			}

			if (newPassword !== confirmPassword) {
				setAuthMessage('New password and confirm password must match.', true);
				return;
			}

			try {
				const data = await postJson('/api/auth/reset-password', { email, currentPassword, newPassword });
				setAuthMessage(data.message || 'Password reset successful. Redirecting to login…', false);
				resetForm.reset();
				// Close the reset panel and redirect to login after a short delay
				const resetPanel = document.getElementById('reset-password-panel');
				if (resetPanel) resetPanel.hidden = true;
				setTimeout(() => {
					const loginHref = window.location.pathname.includes('/pages/') ? '../login.html' : 'login.html';
					if (window.location.pathname.includes('login')) {
						// Already on login page — just scroll to login form
						window.scrollTo({ top: 0, behavior: 'smooth' });
					} else {
						window.location.href = loginHref;
					}
				}, 1500);
			} catch (error) {
				setAuthMessage(error.message || 'Could not reset password.', true);
			}
		});
	}
}

document.addEventListener('DOMContentLoaded', async () => {
	initSidebarToggle();
	bindLogoutLinks();
	bindAuthPanels();
	bindRolePersistenceOnAuthForms();
	bindPasswordToggles();
	bindPasswordAssistanceForms();
	enforceRoleAccess();
	renderTopbarUserMenu(getCachedSessionUser());

	// Hydrate localStorage from server before page inits
	let authenticated = false;
	const isOpsPage = document.body.classList.contains('ops-page');
	try {
		const meRes = await fetch(API_BASE + '/api/auth/me', { credentials: 'include', cache: 'no-store' });
		if (meRes.ok) {
			authenticated = true;
			const me = await meRes.json();
			cacheSessionUser(me?.user || {});
			renderTopbarUserMenu(window.__wwCurrentUser);
			const meEmail = String(me?.user?.email || '').trim().toLowerCase();
			if (meEmail) localStorage.setItem('ww_user_email', meEmail);
			const meRole = resolveEffectiveClientRole(normalizeRole(me?.user?.effectiveRole || me?.user?.role), meEmail);
			if (meRole) {
				localStorage.setItem('ww_user_role', meRole);
				window.__wwUserRole = meRole;
				enforceRoleAccess();
			}
		}
	} catch (_e) { /* offline */ }

	// Redirect to login if not authenticated on ops pages
	if (!authenticated && isOpsPage) {
		const loginHref = window.location.pathname.includes('/pages/') ? '../login.html' : 'login.html';
		window.location.href = loginHref;
		return;
	}

	// ── Phase 1: render immediately from localStorage — zero network wait ──
	initDashboardPage();
	initInventoryPage();
	initSalesInvoicesPage();
	initPurchasePage();
	initAccountingPage();
	initVaultPage();
	initProductionPage();
	initReportsPage();

	// ── Phase 2: background sync — fetch fresh data then re-render ──
	if (authenticated) {
		(async () => {
			try {
				// Flush in background — don't block the data fetch
				flushPendingSalesSyncToServer().catch(() => {});

				const page = document.body.getAttribute('data-page');
				const pageKeyMap = {
					invoices:   ['ww_seed_flags', 'ww_sales_months'],
					sales:      ['ww_seed_flags', 'ww_sales_months'],
					dashboard:  ['ww_seed_flags', 'ww_sales_months', 'ww_raw_materials', 'ww_finished_products', 'ww_accounting_data_v2'],
					inventory:  ['ww_raw_materials', 'ww_finished_products', 'ww_equipment', 'ww_bom_data'],
					accounting: ['ww_accounting_data_v2', 'ww_cost_centre_budgets', 'ww_tax_records'],
					vault:      ['ww_record_vault'],
					purchase:   ['ww_purchase_data_v2'],
					production: ['ww_production_batches', 'ww_daily_production', 'ww_raw_materials', 'ww_finished_products'],
					reports:    ['ww_sales_months', 'ww_accounting_data_v2', 'ww_production_batches', 'ww_daily_production'],
				};
				const priorityKeys = pageKeyMap[page] || ['ww_seed_flags', 'ww_sales_months'];
				await loadBulkFromServer(priorityKeys);

				if (page === 'invoices' || page === 'sales') {
					const salesMonths = getSalesMonths();
					if (salesMonths.length) await loadBulkFromServer(salesMonths.map((m) => 'ww_sales_' + m));
				}

				// Re-render current page with fresh data
				if ((page === 'invoices' || page === 'sales') && currentSalesMonth) {
					loadMonthData(currentSalesMonth); renderSalesPage();
				} else if (page === 'dashboard' && typeof refreshDashboardView === 'function') {
					refreshDashboardView();
				} else if (page === 'reports' && typeof renderReportsData === 'function') {
					renderReportsData();
				}
				broadcastRemoteSyncRefresh();

				// Load remaining keys for other pages in the background
				const remainingKeys = ['ww_raw_materials','ww_finished_products','ww_production_batches',
					'ww_daily_production','ww_purchase_data_v2','ww_accounting_data_v2','ww_record_vault','ww_tax_records',
					'ww_cost_centre_budgets','ww_bom_data','ww_equipment','ww_market_yearly_values',
				].filter((k) => !priorityKeys.includes(k));
				if (remainingKeys.length) loadBulkFromServer(remainingKeys).catch(() => {});
			} catch (_e) { console.warn('[Init] Background sync failed:', _e); }
		})();
	}

	// ── SSE: instant cross-device sync ──
	if (authenticated && isOpsPage && !window.__wwLiveSyncConnected) {
		window.__wwLiveSyncConnected = true;
		const handleRealtimeUpdate = async (payload) => {
			if (!shouldProcessRealtimePayload(payload)) return;
			if (window.__wwRemoteSyncInFlight) return;
			window.__wwRemoteSyncInFlight = true;
			try {
				const changedKey = String(payload && payload.key || '').trim();
				if (/^ww_inventory_\d{4}-\d{2}$/.test(changedKey)) {
					await loadFromServerForceFresh(changedKey);
					emitStorageKeyChange(changedKey);
				}
				flushPendingSalesSyncToServer().catch(() => {});
				await pullRemoteDataAndRefreshUi();
				document.dispatchEvent(new Event('ww-refresh-page'));
			} catch (_e) {
				/* noop */
			} finally {
				window.__wwRemoteSyncInFlight = false;
			}
		};

		const connectSocket = async () => {
			if (window.__wwSocketConnected) return;
			if (typeof window.io !== 'function') {
				await new Promise((resolve) => {
					const existing = document.querySelector('script[data-ww-socketio="1"]');
					if (existing) {
						existing.addEventListener('load', () => resolve(), { once: true });
						existing.addEventListener('error', () => resolve(), { once: true });
						return;
					}
					const script = document.createElement('script');
					script.src = (API_BASE || '') + '/socket.io/socket.io.js';
					script.async = true;
					script.dataset.wwSocketio = '1';
					script.onload = () => resolve();
					script.onerror = () => resolve();
					document.head.appendChild(script);
				});
			}
			if (typeof window.io !== 'function') return;
			if (window.__wwSocket) {
				try { window.__wwSocket.close(); } catch (_e) { /* noop */ }
			}
			const socket = window.io(API_BASE || undefined, {
				withCredentials: true,
				transports: ['websocket', 'polling'],
			});
			window.__wwSocket = socket;
			socket.on('connect', () => { window.__wwSocketConnected = true; });
			socket.on('disconnect', () => { window.__wwSocketConnected = false; });
			socket.on('data_updated', handleRealtimeUpdate);
		};

		const connectSse = () => {
			if (window.__wwSseSource) { try { window.__wwSseSource.close(); } catch (_e) {} }
			const es = new EventSource(API_BASE + '/api/live-updates', { withCredentials: true });
			window.__wwSseSource = es;
			es.addEventListener('data_updated', handleRealtimeUpdate);
			es.onerror = () => {
				try { es.close(); } catch (_e) {}
				window.__wwSseSource = null;
				window.__wwLiveSyncConnected = false;
				setTimeout(() => { if (!window.__wwLiveSyncConnected) connectSse(); }, 5000);
			};
		};
		connectSse();
		connectSocket().catch(() => {});
		document.addEventListener('visibilitychange', async () => {
			if (!document.hidden) {
				try {
					await pullRemoteDataAndRefreshUi();
					document.dispatchEvent(new Event('ww-refresh-page'));
				} catch (_e) {}
			}
		});
		if (!window.__wwRealtimePoller) {
			window.__wwRealtimePoller = setInterval(async () => {
				if (document.hidden) return;
				if (window.__wwSseSource || window.__wwSocketConnected) return;
				try {
					await pullRemoteDataAndRefreshUi();
					document.dispatchEvent(new Event('ww-refresh-page'));
				} catch (_e) { /* noop */ }
			}, 15000);
		}
	}

	// After all pages render, hide edit/delete in dynamic content for restricted roles
	if (document.body.classList.contains('role-restricted')) {
		const observer = new MutationObserver(() => {
			document.querySelectorAll('.btn-edit, .btn-delete, [data-action="edit"], [data-action="delete"]').forEach((btn) => {
				btn.style.display = 'none';
			});
		});
		observer.observe(document.querySelector('.ops-main') || document.body, { childList: true, subtree: true });
	}
});