// Book management: the layer above every other screen.
//
// A Book is a separate financial workspace with its own Treasury, Accounts, positions,
// liabilities, strategies and accounting history. This page opens, renames and creates Books.
// It deliberately has no totals across Books: nothing is ever combined between them.
import { html, useState } from '../vendor/preact-htm.js';
import { fmtTime, get, openOverlay, post, put, refreshStatus, setBook, toast, toastError, useLive, useStore } from '../lib/core.js';
import { Button, Field, Modal, NavValue, Notice, Num, Panel, Pill, Table, Text } from '../lib/ui.js';

function BookDialog({ book, onClose }) {
  const [name, setName] = useState(book?.name || '');
  const [ccy, setCcy] = useState('USD');
  const [cash, setCash] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (book) {
        await put(`/api/books/${book.id}`, { name });
        toast('Book renamed.');
      } else {
        const b = await post('/api/books', { name, reportingCcy: ccy.toUpperCase() });
        if (cash > 0) await post(`/api/books/${b.id}/capital`, { type: 'deposit', ccy: ccy.toUpperCase(), amount: cash, note: 'Starting capital' });
        await refreshStatus();
        setBook(b.id);
        toast(`Book "${b.name}" created with its own Treasury. It is now the selected Book.`);
        location.hash = '#/treasury';
      }
      await refreshStatus();
      onClose();
    } catch (err) { toastError(err); setBusy(false); }
  };
  return html`<${Modal} title=${book ? 'Rename Book' : 'New Book'} sub=${book ? '' : 'A new Book starts empty, with its own Treasury. Nothing is shared with any other Book.'} onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!name.trim()} onClick=${save}>${book ? 'Rename Book' : 'Create Book'}<//>`}>
    <div class="grid-form">
      <${Field} label="Book name" span=${2}><${Text} value=${name} onInput=${setName} autofocus /><//>
      ${!book ? html`<${Field} label="Reporting currency" hint="Fixed once the Book exists"><${Text} value=${ccy} onInput=${setCcy} /><//>
        <${Field} label="Starting paper capital" hint="Deposited into its Treasury. Optional."><${Num} value=${cash} onInput=${setCash} /><//>` : null}
    </div><//>`;
}

export default function Books() {
  const books = useStore((s) => s.books);
  const bookId = useStore((s) => s.bookId);
  // Each Book's own figures, in its own reporting currency. They are never added together.
  const navs = useLive(async () => Object.fromEntries(await Promise.all(books.map(async (b) => [b.id, (await get(`/api/books/${b.id}`)).overview]))), [books.map((b) => b.id).join()]);
  const open = (b) => { setBook(b.id); location.hash = '#/accounting'; };
  return html`<div>
    <div class="page-head"><div><h1>Books</h1>
      <div class="sub">Each Book is a separate workspace with its own Treasury, Accounts, positions, liabilities, strategies and accounting history. One Book is selected at a time, and every other screen shows that Book only.</div></div>
      <div class="actions"><${Button} kind="primary" onClick=${() => openOverlay((close) => html`<${BookDialog} onClose=${close} />`)}>New Book<//></div></div>
    <${Panel} flush>
      <${Table} margin rows=${books} rowKey=${(b) => b.id} columns=${[
        { label: 'Book', render: (b) => html`<div class="strong">${b.name}${b.id === bookId ? html` <${Pill} tone="ok">selected<//>` : null}</div><div class="sub">${b.id}</div>` },
        { label: 'Reporting currency', render: (b) => b.reportingCcy },
        { label: 'Structure', render: (b) => { const n = b.units.filter((u) => u.kind === 'account').length; return `Treasury and ${n} Account${n === 1 ? '' : 's'}`; } },
        { label: 'Net asset value, in its own currency', align: 'r', render: (b) => { const o = navs.data?.[b.id]; return o ? html`<${NavValue} nav=${{ value: o.nav, provisional: o.navProvisional, affected: o.navAffected }} ccy=${b.reportingCcy} />` : ''; } },
        { label: 'Created', render: (b) => fmtTime(b.createdAt) },
        { label: '', align: 'r', render: (b) => html`${b.id === bookId ? html`<${Button} small onClick=${() => { location.hash = '#/accounting'; }}>Open<//>` : html`<${Button} small onClick=${() => open(b)}>Select and open<//>`} <${Button} small onClick=${() => openOverlay((close) => html`<${BookDialog} book=${b} onClose=${close} />`)}>Rename<//>` },
      ]} />
    <//>
    <div style="margin-top:10px"><${Notice}>Books are not consolidated. There is no combined view, total or transfer across Books: accounting spans the selected Book's Treasury and Accounts and nothing else.<//></div>
  </div>`;
}
