/* ===========================================================
   Wishkeeper — Supabase-backed wishlist app
   Auth: Supabase magic-link email sign-in
   Data: Postgres tables `lists` and `items`, RLS-scoped per user
   Fetch: `fetch-product` Edge Function (server-side, no CORS issues)
   Sync: Postgres realtime — changes on any device reflect here
   =========================================================== */

const DEFAULT_CATEGORIES = ['Clothing', 'Electronics', 'Home & Kitchen', 'Beauty', 'Books', 'Toys & Games', 'Sports & Outdoors', 'Other'];

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let state = { lists: {}, activeListId: null }; // lists[id] = { id, name, items: [] }
let editingItemId = null;
let editingListId = null;
let realtimeChannel = null;

// ---------------- Auth ----------------

async function initAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session?.user) await enterApp(session.user);
  else showAuthScreen();

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      await enterApp(session.user);
    } else if (event === 'SIGNED_OUT') {
      showAuthScreen();
    }
  });
}

function showAuthScreen() {
  currentUser = null;
  if (realtimeChannel) { supabaseClient.removeChannel(realtimeChannel); realtimeChannel = null; }
  document.getElementById('appScreen').hidden = true;
  document.getElementById('authScreen').hidden = false;
  document.getElementById('authFormStep').hidden = false;
  document.getElementById('authSentStep').hidden = true;
}

async function enterApp(user) {
  currentUser = user;
  document.getElementById('authScreen').hidden = true;
  document.getElementById('appScreen').hidden = false;
  document.getElementById('userEmailLabel').textContent = user.email || '';
  await loadLists();
  subscribeRealtime();
}

async function handleSendMagicLink() {
  const email = document.getElementById('authEmail').value.trim();
  const status = document.getElementById('authStatus');
  const btn = document.getElementById('authSubmitBtn');
  if (!email) { status.textContent = 'Enter your email address.'; status.className = 'fetch-status error'; return; }

  btn.disabled = true;
  btn.textContent = 'Sending…';
  status.textContent = '';
  status.className = 'fetch-status';

  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href },
  });

  btn.disabled = false;
  btn.textContent = 'Send magic link';

  if (error) {
    status.textContent = error.message || 'Could not send the link. Try again.';
    status.className = 'fetch-status error';
    return;
  }

  document.getElementById('authSentEmail').textContent = email;
  document.getElementById('authFormStep').hidden = true;
  document.getElementById('authSentStep').hidden = false;
}

async function handleSignOut() {
  await supabaseClient.auth.signOut();
}

// ---------------- Loading data ----------------

async function loadLists() {
  const { data, error } = await supabaseClient
    .from('lists')
    .select('id, name, created_at, items(*)')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: true })
    .order('date_added', { foreignTable: 'items', ascending: false });

  if (error) {
    showToast("Couldn't load your wishlists");
    console.error(error);
    return;
  }

  const previousActive = state.activeListId;
  const lists = {};
  data.forEach(row => {
    lists[row.id] = {
      id: row.id,
      name: row.name,
      items: (row.items || []).map(normalizeItem),
    };
  });
  state.lists = lists;
  state.activeListId = (previousActive && lists[previousActive]) ? previousActive : (data[0]?.id ?? null);

  renderTabs();
  renderCategoryFilter();
  renderItems();
}

function normalizeItem(row) {
  return {
    id: row.id,
    url: row.url,
    image: row.image,
    title: row.title,
    price: row.price != null ? Number(row.price) : null,
    currency: row.currency || '$',
    category: row.category || 'Other',
    note: row.note,
    dateAdded: new Date(row.date_added).getTime(),
  };
}

function subscribeRealtime() {
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel = supabaseClient
    .channel('wishkeeper-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `user_id=eq.${currentUser.id}` }, () => loadLists())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lists', filter: `user_id=eq.${currentUser.id}` }, () => loadLists())
    .subscribe();
}

function activeList() {
  return state.lists[state.activeListId];
}

// ---------------- Toast ----------------

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

// ---------------- List tabs ----------------

function renderTabs() {
  const nav = document.getElementById('listTabs');
  nav.innerHTML = '';
  Object.values(state.lists).forEach(list => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (list.id === state.activeListId ? ' active' : '');
    btn.type = 'button';
    btn.innerHTML = `${escapeHtml(list.name)} <span class="tab-count">${list.items.length}</span>`;
    btn.addEventListener('click', () => {
      state.activeListId = list.id;
      renderTabs();
      renderCategoryFilter();
      renderItems();
    });
    if (list.id === state.activeListId) {
      const menuBtn = document.createElement('button');
      menuBtn.className = 'tab-menu-btn';
      menuBtn.type = 'button';
      menuBtn.innerHTML = '&#8942;';
      menuBtn.title = 'Rename or delete this list';
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openListMenu(list);
      });
      btn.appendChild(menuBtn);
    }
    nav.appendChild(btn);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'tab-add';
  addBtn.type = 'button';
  addBtn.textContent = '+ New list';
  addBtn.addEventListener('click', () => openListModal(null));
  nav.appendChild(addBtn);
}

function openListMenu(list) {
  const choice = prompt(`"${list.name}" — type "rename" to rename, or "delete" to delete this list:`, 'rename');
  if (!choice) return;
  if (choice.toLowerCase().startsWith('r')) {
    openListModal(list.id);
  } else if (choice.toLowerCase().startsWith('d')) {
    if (Object.keys(state.lists).length === 1) {
      showToast("Can't delete your only list");
      return;
    }
    if (confirm(`Delete "${list.name}" and all ${list.items.length} item(s)? This can't be undone.`)) {
      deleteList(list.id);
    }
  }
}

async function deleteList(listId) {
  const { error } = await supabaseClient.from('lists').delete().eq('id', listId);
  if (error) { showToast('Could not delete that list'); return; }
  if (state.activeListId === listId) {
    const remaining = Object.keys(state.lists).filter(id => id !== listId);
    state.activeListId = remaining[0] || null;
  }
  await loadLists();
  showToast('List deleted');
}

function openListModal(listId) {
  editingListId = listId;
  const modal = document.getElementById('listModal');
  const input = document.getElementById('listNameInput');
  document.getElementById('listModalTitle').textContent = listId ? 'Rename wishlist' : 'New wishlist';
  input.value = listId ? state.lists[listId].name : '';
  modal.hidden = false;
  input.focus();
}

function closeListModal() {
  document.getElementById('listModal').hidden = true;
  editingListId = null;
}

async function saveListModal() {
  const name = document.getElementById('listNameInput').value.trim();
  if (!name) { showToast('Give the list a name'); return; }

  if (editingListId) {
    const { error } = await supabaseClient.from('lists').update({ name }).eq('id', editingListId);
    if (error) { showToast('Could not rename that list'); return; }
  } else {
    const { data, error } = await supabaseClient
      .from('lists')
      .insert({ name, user_id: currentUser.id })
      .select()
      .single();
    if (error) { showToast('Could not create that list'); return; }
    state.activeListId = data.id;
  }
  closeListModal();
  await loadLists();
}

// ---------------- Category filter ----------------

function allCategoriesInUse() {
  const set = new Set(DEFAULT_CATEGORIES);
  (activeList()?.items || []).forEach(i => set.add(i.category || 'Other'));
  return Array.from(set);
}

function renderCategoryFilter() {
  const sel = document.getElementById('categoryFilter');
  const current = sel.value || 'all';
  sel.innerHTML = '<option value="all">All categories</option>' +
    allCategoriesInUse().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = Array.from(sel.options).some(o => o.value === current) ? current : 'all';
}

function populateItemCategorySelect(selected) {
  const sel = document.getElementById('itemCategory');
  const cats = allCategoriesInUse();
  sel.innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('') +
    '<option value="__custom__">+ New category…</option>';
  sel.value = selected && cats.includes(selected) ? selected : cats[0];
}

// ---------------- Rendering items ----------------

function getFilteredSortedItems() {
  if (!activeList()) return [];
  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  const category = document.getElementById('categoryFilter').value;
  const sort = document.getElementById('sortSelect').value;

  let items = activeList().items.filter(i => {
    const matchesSearch = !search || i.title.toLowerCase().includes(search) || (i.note || '').toLowerCase().includes(search);
    const matchesCategory = category === 'all' || i.category === category;
    return matchesSearch && matchesCategory;
  });

  items = items.slice().sort((a, b) => {
    switch (sort) {
      case 'priceAsc': return (a.price ?? Infinity) - (b.price ?? Infinity);
      case 'priceDesc': return (b.price ?? -Infinity) - (a.price ?? -Infinity);
      case 'alpha': return a.title.localeCompare(b.title);
      default: return b.dateAdded - a.dateAdded;
    }
  });

  return items;
}

function renderItems() {
  const grid = document.getElementById('itemsGrid');
  const empty = document.getElementById('emptyState');
  const items = getFilteredSortedItems();

  grid.innerHTML = '';
  const hasAnyItems = (activeList()?.items.length || 0) > 0;
  empty.hidden = items.length > 0;
  if (items.length === 0) {
    empty.querySelector('.empty-sub').textContent = hasAnyItems
      ? 'No items match your search or filter.'
      : 'Paste a product link or add one by hand to start this list.';
  }

  items.forEach(item => grid.appendChild(renderCard(item)));
}

function renderCard(item) {
  const card = document.createElement('article');
  card.className = 'tag-card';
  card.tabIndex = 0;

  const priceText = item.price != null ? `${item.currency || '$'}${Number(item.price).toFixed(2)}` : '';

  card.innerHTML = `
    <span class="grommet" aria-hidden="true"></span>
    <div class="tag-actions">
      <button class="icon-btn" data-action="edit" title="Edit" aria-label="Edit item">&#9998;</button>
      <button class="icon-btn danger" data-action="delete" title="Delete" aria-label="Delete item">&#10005;</button>
    </div>
    <div class="tag-thumb">${item.image ? `<img src="${escapeAttr(item.image)}" alt="" loading="lazy">` : 'No image'}</div>
    <div class="tag-body">
      <span class="tag-category">${escapeHtml(item.category || 'Other')}</span>
      <h3 class="tag-title">${escapeHtml(item.title || 'Untitled item')}</h3>
      ${priceText ? `<div class="tag-price">${escapeHtml(priceText)}</div>` : ''}
      ${item.note ? `<p class="tag-note">${escapeHtml(item.note)}</p>` : ''}
    </div>
  `;

  card.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
    e.stopPropagation();
    openItemModal(item.id);
  });
  card.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm(`Remove "${item.title}" from this list?`)) deleteItem(item.id);
  });
  card.addEventListener('click', () => {
    if (item.url) window.open(item.url, '_blank', 'noopener');
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && item.url) window.open(item.url, '_blank', 'noopener');
  });

  return card;
}

async function deleteItem(itemId) {
  const { error } = await supabaseClient.from('items').delete().eq('id', itemId);
  if (error) { showToast('Could not delete that item'); return; }
  await loadLists();
  showToast('Item removed');
}

// ---------------- Item modal ----------------

function openItemModal(itemId) {
  editingItemId = itemId;
  const isEdit = !!itemId;
  document.getElementById('modalTitle').textContent = isEdit ? 'Edit item' : 'Add item';
  const item = isEdit ? activeList().items.find(i => i.id === itemId) : null;

  document.getElementById('itemUrl').value = item?.url || '';
  document.getElementById('itemImage').value = item?.image || '';
  document.getElementById('itemTitle').value = item?.title || '';
  document.getElementById('itemPrice').value = item?.price ?? '';
  document.getElementById('itemCurrency').value = item?.currency || '$';
  document.getElementById('itemNote').value = item?.note || '';
  document.getElementById('fetchStatus').textContent = '';
  document.getElementById('fetchStatus').className = 'fetch-status';
  document.getElementById('itemCategoryCustom').hidden = true;
  document.getElementById('itemCategoryCustom').value = '';

  populateItemCategorySelect(item?.category);
  updateImagePreview(item?.image || '');

  document.getElementById('itemModal').hidden = false;
  document.getElementById('itemUrl').focus();
}

function closeItemModal() {
  document.getElementById('itemModal').hidden = true;
  editingItemId = null;
}

function updateImagePreview(url) {
  const wrap = document.getElementById('imagePreviewWrap');
  const img = document.getElementById('imagePreview');
  if (url) {
    img.src = url;
    wrap.classList.add('has-image');
    img.onerror = () => wrap.classList.remove('has-image');
  } else {
    img.src = '';
    wrap.classList.remove('has-image');
  }
}

function guessCategory(text) {
  const t = text.toLowerCase();
  const rules = [
    [/shirt|jacket|dress|jeans|sneaker|shoe|hoodie|sweater|coat|apparel|clothing/, 'Clothing'],
    [/phone|laptop|headphone|earbud|camera|charger|tablet|monitor|console|tv\b/, 'Electronics'],
    [/mug|blanket|candle|kitchen|cookware|decor|furniture|lamp/, 'Home & Kitchen'],
    [/lipstick|skincare|makeup|perfume|cologne|serum/, 'Beauty'],
    [/book|novel|hardcover|paperback/, 'Books'],
    [/toy|lego|game|puzzle|figure/, 'Toys & Games'],
    [/bike|yoga|dumbbell|tent|backpack|cleats|racket/, 'Sports & Outdoors'],
  ];
  for (const [re, cat] of rules) if (re.test(t)) return cat;
  return null;
}

async function handleFetchClick() {
  const url = document.getElementById('itemUrl').value.trim();
  const status = document.getElementById('fetchStatus');
  const btn = document.getElementById('fetchBtn');
  if (!url) { status.textContent = 'Paste a product link first.'; status.className = 'fetch-status error'; return; }

  btn.disabled = true;
  btn.textContent = 'Fetching…';
  status.textContent = 'Looking up product details…';
  status.className = 'fetch-status';

  try {
    const { data, error } = await supabaseClient.functions.invoke('fetch-product', { body: { url } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);

    if (data.title) document.getElementById('itemTitle').value = data.title;
    if (data.image) { document.getElementById('itemImage').value = data.image; updateImagePreview(data.image); }
    if (data.price != null) document.getElementById('itemPrice').value = data.price;
    const guess = guessCategory((data.title || '') + ' ' + url);
    if (guess) populateItemCategorySelect(guess);

    const gotAll = data.title && data.image && data.price != null;
    status.textContent = gotAll
      ? 'Got it — details filled in below.'
      : 'Got partial details — please fill in the rest by hand.';
    status.className = 'fetch-status success';
  } catch (err) {
    console.error(err);
    status.textContent = "Couldn't read that page automatically (many stores block this). Fill in the details below manually.";
    status.className = 'fetch-status error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch details';
  }
}

async function saveItemModal() {
  const url = document.getElementById('itemUrl').value.trim();
  const image = document.getElementById('itemImage').value.trim();
  const title = document.getElementById('itemTitle').value.trim();
  const priceVal = document.getElementById('itemPrice').value;
  const currency = document.getElementById('itemCurrency').value;
  const note = document.getElementById('itemNote').value.trim();
  let category = document.getElementById('itemCategory').value;
  if (category === '__custom__') {
    category = document.getElementById('itemCategoryCustom').value.trim() || 'Other';
  }

  if (!title) { showToast('Give the item a name'); document.getElementById('itemTitle').focus(); return; }

  const payload = {
    url: url || null,
    image: image || null,
    title,
    price: priceVal === '' ? null : parseFloat(priceVal),
    currency,
    category,
    note: note || null,
  };

  const saveBtn = document.getElementById('saveItemBtn');
  saveBtn.disabled = true;

  let error;
  if (editingItemId) {
    ({ error } = await supabaseClient.from('items').update(payload).eq('id', editingItemId));
  } else {
    ({ error } = await supabaseClient.from('items').insert({
      ...payload,
      list_id: state.activeListId,
      user_id: currentUser.id,
    }));
  }

  saveBtn.disabled = false;

  if (error) { showToast('Could not save that item'); console.error(error); return; }

  closeItemModal();
  await loadLists();
  showToast(editingItemId ? 'Item updated' : 'Item added');
}

// ---------------- Utils ----------------

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

// ---------------- Wire up ----------------

document.getElementById('authSubmitBtn').addEventListener('click', handleSendMagicLink);
document.getElementById('authEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSendMagicLink(); });
document.getElementById('authBackBtn').addEventListener('click', () => {
  document.getElementById('authFormStep').hidden = false;
  document.getElementById('authSentStep').hidden = true;
});
document.getElementById('signOutBtn').addEventListener('click', handleSignOut);

document.getElementById('addItemBtn').addEventListener('click', () => openItemModal(null));
document.getElementById('closeModalBtn').addEventListener('click', closeItemModal);
document.getElementById('cancelItemBtn').addEventListener('click', closeItemModal);
document.getElementById('saveItemBtn').addEventListener('click', saveItemModal);
document.getElementById('fetchBtn').addEventListener('click', handleFetchClick);
document.getElementById('itemImage').addEventListener('input', (e) => updateImagePreview(e.target.value.trim()));
document.getElementById('itemCategory').addEventListener('change', (e) => {
  document.getElementById('itemCategoryCustom').hidden = e.target.value !== '__custom__';
  if (e.target.value === '__custom__') document.getElementById('itemCategoryCustom').focus();
});
document.getElementById('itemModal').addEventListener('click', (e) => {
  if (e.target.id === 'itemModal') closeItemModal();
});

document.getElementById('closeListModalBtn').addEventListener('click', closeListModal);
document.getElementById('cancelListBtn').addEventListener('click', closeListModal);
document.getElementById('saveListBtn').addEventListener('click', saveListModal);
document.getElementById('listModal').addEventListener('click', (e) => {
  if (e.target.id === 'listModal') closeListModal();
});
document.getElementById('listNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveListModal();
});

document.getElementById('searchInput').addEventListener('input', renderItems);
document.getElementById('categoryFilter').addEventListener('change', renderItems);
document.getElementById('sortSelect').addEventListener('change', renderItems);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeItemModal(); closeListModal(); }
});

// ---------------- Init ----------------

initAuth();
