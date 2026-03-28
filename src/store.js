/* ═══════════════════════════════════════════════════
   WHITE WATER WELLS — CUSTOMER STORE LOGIC
   ═══════════════════════════════════════════════════ */

(function () {
	'use strict';

	// ── State ──
	let currentCustomer = null;
	let cart = JSON.parse(localStorage.getItem('ww_store_cart') || '[]');

	const $ = (sel, ctx) => (ctx || document).querySelector(sel);
	const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];
	const fmt = (n) => `GH₵ ${Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

	// ═══════ INIT ═══════
	async function init() {
		bindNavbar();
		bindCart();
		await checkSession();
		await loadProducts();
		renderCart();
	}

	// ═══════ NAVBAR ═══════
	function bindNavbar() {
		const hamburger = $('#hamburger');
		const nav = $('#st-nav');
		if (hamburger && nav) {
			hamburger.addEventListener('click', () => nav.classList.toggle('open'));
			document.addEventListener('click', (e) => {
				if (!e.target.closest('.st-nav') && !e.target.closest('.st-hamburger')) nav.classList.remove('open');
			});
		}

		window.addEventListener('scroll', () => {
			$('#st-navbar').classList.toggle('scrolled', window.scrollY > 20);
		});

		// User dropdown
		const userBtn = $('#user-btn');
		const dropdown = $('#user-dropdown');
		if (userBtn && dropdown) {
			userBtn.addEventListener('click', () => dropdown.classList.toggle('open'));
			document.addEventListener('click', (e) => {
				if (!e.target.closest('.st-user-menu')) dropdown.classList.remove('open');
			});
		}
	}

	// ═══════ AUTH SESSION ═══════
	async function checkSession() {
		try {
			const res = await fetch('/api/store/me');
			if (res.ok) {
				const data = await res.json();
				setLoggedIn(data.customer);
			}
		} catch (_) { /* not logged in */ }
	}

	function setLoggedIn(customer) {
		currentCustomer = customer;
		$('#auth-btns').style.display = 'none';
		$('#user-menu').style.display = '';
		$('#user-name').textContent = customer.name.split(' ')[0];
	}

	function setLoggedOut() {
		currentCustomer = null;
		$('#auth-btns').style.display = '';
		$('#user-menu').style.display = 'none';
	}

	// ═══════ MODALS ═══════
	window.openModal = function (type) {
		closeModal();
		$('#modal-overlay').classList.add('open');
		const modal = $(`#${type}-modal`);
		if (modal) modal.classList.add('open');
	};

	window.closeModal = function () {
		$('#modal-overlay').classList.remove('open');
		$$('.st-modal').forEach((m) => m.classList.remove('open'));
	};

	$('#modal-overlay').addEventListener('click', closeModal);

	// ═══════ REGISTER ═══════
	window.handleRegister = async function (e) {
		e.preventDefault();
		const form = e.target;
		const errEl = $('#register-error');
		errEl.textContent = '';

		const body = {
			name: form.name.value.trim(),
			email: form.email.value.trim(),
			phone: form.phone.value.trim(),
			password: form.password.value,
			address: form.address.value.trim(),
			city: form.city.value.trim(),
			region: form.region.value,
		};

		try {
			const res = await fetch('/api/store/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.message || 'Registration failed');
			setLoggedIn(data.customer);
			closeModal();
			form.reset();
		} catch (err) {
			errEl.textContent = err.message;
		}
	};

	// ═══════ LOGIN ═══════
	window.handleLogin = async function (e) {
		e.preventDefault();
		const form = e.target;
		const errEl = $('#login-error');
		errEl.textContent = '';

		try {
			const res = await fetch('/api/store/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: form.email.value.trim(),
					password: form.password.value,
				}),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.message || 'Login failed');
			setLoggedIn(data.customer);
			closeModal();
			form.reset();
		} catch (err) {
			errEl.textContent = err.message;
		}
	};

	// ═══════ LOGOUT ═══════
	window.storeLogout = async function () {
		await fetch('/api/store/logout', { method: 'POST' });
		setLoggedOut();
		showSection('home');
	};

	// ═══════ PRODUCTS ═══════
	async function loadProducts() {
		const grid = $('#products-grid');
		try {
			const res = await fetch('/api/store/products');
			const products = await res.json();
			if (!products.length) {
				grid.innerHTML = '<p class="st-loading">No products available right now. Check back soon!</p>';
				return;
			}
			grid.innerHTML = products.map((p) => `
				<div class="st-product-card" data-product-id="${p.id}">
					<div class="st-product-img"><i class="fa-solid fa-droplet"></i></div>
					<div class="st-product-body">
						<h3>${esc(p.name)}</h3>
						<p class="st-product-desc">${esc(p.description || '')}</p>
						<div class="st-product-footer">
							<div class="st-product-price">${fmt(p.price)} <small>/ ${esc(p.unit)}</small></div>
							<div class="st-product-qty">
								<button class="st-qty-btn" onclick="adjustQty(this,-1)">−</button>
								<input class="st-qty-val" type="number" value="${p.min_order}" min="${p.min_order}" data-min="${p.min_order}">
								<button class="st-qty-btn" onclick="adjustQty(this,1)">+</button>
							</div>
						</div>
						<button class="st-btn st-btn-primary st-btn-block st-add-cart" onclick="addToCart(${p.id}, '${esc(p.name)}', ${p.price}, '${esc(p.unit)}', this)">
							<i class="fa-solid fa-cart-plus"></i> Add to Cart
						</button>
					</div>
				</div>
			`).join('');
		} catch (_) {
			grid.innerHTML = '<p class="st-loading">Unable to load products. Please refresh.</p>';
		}
	}

	window.adjustQty = function (btn, delta) {
		const wrap = btn.closest('.st-product-qty');
		const input = wrap.querySelector('.st-qty-val');
		const min = Number(input.dataset.min) || 1;
		input.value = Math.max(min, Number(input.value) + delta);
	};

	window.addToCart = function (productId, name, price, unit, btn) {
		const card = btn.closest('.st-product-card');
		const qty = Number(card.querySelector('.st-qty-val').value) || 1;

		const existing = cart.find((i) => i.productId === productId);
		if (existing) {
			existing.qty += qty;
		} else {
			cart.push({ productId, name, price, unit, qty });
		}
		saveCart();
		renderCart();

		// Feedback animation
		btn.textContent = '✓ Added!';
		btn.disabled = true;
		setTimeout(() => {
			btn.innerHTML = '<i class="fa-solid fa-cart-plus"></i> Add to Cart';
			btn.disabled = false;
		}, 1200);
	};

	// ═══════ CART ═══════
	function bindCart() {
		$('#cart-toggle').addEventListener('click', toggleCart);
		$('#cart-close').addEventListener('click', toggleCart);
		$('#cart-overlay').addEventListener('click', toggleCart);
		$('#checkout-btn').addEventListener('click', openCheckout);
	}

	function toggleCart() {
		$('#cart-drawer').classList.toggle('open');
		$('#cart-overlay').classList.toggle('open');
	}

	function saveCart() {
		localStorage.setItem('ww_store_cart', JSON.stringify(cart));
	}

	function renderCart() {
		const badge = $('#cart-badge');
		const body = $('#cart-body');
		const footer = $('#cart-footer');
		const totalEl = $('#cart-total');

		const count = cart.reduce((s, i) => s + i.qty, 0);
		badge.style.display = count > 0 ? '' : 'none';
		badge.textContent = count;

		if (cart.length === 0) {
			body.innerHTML = '<p class="st-cart-empty">Your cart is empty.</p>';
			footer.style.display = 'none';
			return;
		}

		footer.style.display = '';
		const total = cart.reduce((s, i) => s + i.qty * i.price, 0);
		totalEl.textContent = fmt(total);

		body.innerHTML = cart.map((item, idx) => `
			<div class="st-cart-item">
				<div class="st-cart-item-icon"><i class="fa-solid fa-droplet"></i></div>
				<div class="st-cart-item-info">
					<div class="st-cart-item-name">${esc(item.name)}</div>
					<div class="st-cart-item-price">${fmt(item.price)} × ${item.qty} = ${fmt(item.qty * item.price)}</div>
				</div>
				<div class="st-cart-item-qty">
					<button onclick="cartQty(${idx},-1)">−</button>
					<span>${item.qty}</span>
					<button onclick="cartQty(${idx},1)">+</button>
				</div>
				<button class="st-cart-item-remove" onclick="cartRemove(${idx})" title="Remove"><i class="fa-solid fa-trash"></i></button>
			</div>
		`).join('');
	}

	window.cartQty = function (idx, delta) {
		if (!cart[idx]) return;
		cart[idx].qty = Math.max(1, cart[idx].qty + delta);
		saveCart();
		renderCart();
	};

	window.cartRemove = function (idx) {
		cart.splice(idx, 1);
		saveCart();
		renderCart();
	};

	// ═══════ CHECKOUT ═══════
	function openCheckout() {
		if (!currentCustomer) {
			toggleCart();
			openModal('login');
			return;
		}
		if (cart.length === 0) return;

		toggleCart();

		const total = cart.reduce((s, i) => s + i.qty * i.price, 0);
		$('#checkout-summary').innerHTML = `
			<table>
				<thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
				<tbody>
					${cart.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${fmt(i.qty * i.price)}</td></tr>`).join('')}
				</tbody>
				<tfoot><tr><td colspan="2"><strong>Total</strong></td><td class="checkout-total">${fmt(total)}</td></tr></tfoot>
			</table>
		`;

		// Pre-fill from customer profile
		const form = $('#checkout-form');
		if (currentCustomer.address) form.deliveryAddress.value = currentCustomer.address;
		if (currentCustomer.city) form.deliveryCity.value = currentCustomer.city;
		if (currentCustomer.region) form.deliveryRegion.value = currentCustomer.region;
		if (currentCustomer.phone) form.phone.value = currentCustomer.phone;

		openModal('checkout');
	}

	window.handleCheckout = async function (e) {
		e.preventDefault();
		const form = e.target;
		const errEl = $('#checkout-error');
		errEl.textContent = '';

		const body = {
			items: cart.map((i) => ({ productId: i.productId, qty: i.qty })),
			deliveryAddress: form.deliveryAddress.value.trim(),
			deliveryCity: form.deliveryCity.value.trim(),
			deliveryRegion: form.deliveryRegion.value,
			phone: form.phone.value.trim(),
			notes: form.notes.value.trim(),
		};

		try {
			const res = await fetch('/api/store/orders', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.message || 'Order failed');

			// Clear cart
			cart = [];
			saveCart();
			renderCart();

			closeModal();
			$('#success-message').textContent = `Order ${data.order.orderCode} placed successfully! Total: ${fmt(data.order.total)}. We'll process it shortly.`;
			openModal('success');
		} catch (err) {
			errEl.textContent = err.message;
		}
	};

	// ═══════ ORDERS ═══════
	window.showSection = function (section) {
		const ordersSection = $('#orders-section');
		const heroSection = $('#hero');
		const mainSections = $$('#products, #how-it-works, #contact, #footer');

		if (section === 'orders') {
			ordersSection.style.display = '';
			if (heroSection) heroSection.style.display = 'none';
			mainSections.forEach((s) => s.style.display = 'none');
			loadOrders();
			window.scrollTo({ top: 0, behavior: 'smooth' });
		} else {
			ordersSection.style.display = 'none';
			if (heroSection) heroSection.style.display = '';
			mainSections.forEach((s) => s.style.display = '');
		}
	};

	async function loadOrders() {
		const list = $('#orders-list');
		list.innerHTML = '<div class="st-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading orders...</div>';

		try {
			const res = await fetch('/api/store/orders');
			if (!res.ok) throw new Error('Not authenticated');
			const orders = await res.json();

			if (!orders.length) {
				list.innerHTML = '<div class="st-no-orders"><i class="fa-solid fa-box-open" style="font-size:2.5rem;display:block;margin-bottom:12px"></i>No orders yet. Start shopping!</div>';
				return;
			}

			list.innerHTML = orders.map((o) => {
				const statusClass = `st-status-${o.status.toLowerCase().replace(/\s/g, '')}`;
				const items = o.items.map((i) => `${i.name} × ${i.qty}`).join(', ');
				const date = new Date(o.createdAt).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' });
				return `
					<div class="st-order-card">
						<div class="st-order-top">
							<div>
								<span class="st-order-code">${esc(o.orderCode)}</span>
								<span class="st-order-date"> · ${date}</span>
							</div>
							<span class="st-order-status ${statusClass}"><i class="fa-solid fa-circle" style="font-size:0.5em"></i> ${esc(o.status)}</span>
						</div>
						<div class="st-order-items">${esc(items)}</div>
						<div class="st-order-total">${fmt(o.total)}</div>
					</div>
				`;
			}).join('');
		} catch (_) {
			list.innerHTML = '<div class="st-no-orders">Please log in to view your orders.</div>';
		}
	}

	// ═══════ HELPERS ═══════
	function esc(str) {
		const d = document.createElement('div');
		d.textContent = str || '';
		return d.innerHTML;
	}

	// ═══════ BOOT ═══════
	document.addEventListener('DOMContentLoaded', init);
})();
