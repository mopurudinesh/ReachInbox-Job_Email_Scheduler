import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Cloud, Image as ImageIcon, Indent, Italic,
  Link2, List, ListOrdered, LockKeyhole, Maximize2, Minimize2, Minus, MoreHorizontal,
  Outdent, Paperclip, Quote, Redo2, Smile, Strikethrough, Type, Underline, Undo2, X,
} from 'lucide-react';

export type LocalAttachment = {
  fileName: string;
  contentType: string;
  size: number;
  contentBase64: string;
  inline: boolean;
  contentId?: string;
};

type ComposeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  attachments: LocalAttachment[];
  onAttachmentsChange: (attachments: LocalAttachment[]) => void;
  signature: string;
  onError: (message: string) => void;
  minimized: boolean;
  onMinimizeChange: (value: boolean) => void;
  expanded: boolean;
  onExpandedChange: (value: boolean) => void;
  onClose: () => void;
};

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const toolbarButton = 'grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-600 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const emojis = ['🙂', '😀', '😊', '🎉', '👍', '❤️', '🙏', '✅', '📌', '✨'];

export function ComposeEditor({ value, onChange, attachments, onAttachmentsChange, signature, onError, minimized, onMinimizeChange, expanded, onExpandedChange, onClose }: ComposeEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) editorRef.current.innerHTML = value;
  }, [value]);

  function command(name: string, argument?: string) {
    editorRef.current?.focus();
    document.execCommand(name, false, argument);
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  }

  function addLink() {
    const entered = window.prompt('Enter a link URL (https:// or mailto:)');
    if (!entered) return;
    const url = entered.trim();
    if (!/^(https?:\/\/|mailto:)/i.test(url)) { onError('Use a link starting with https:// or mailto:.'); return; }
    command('createLink', url);
  }

  function addSignature() {
    if (!signature.trim()) { onError('Choose a sender profile before adding its signature.'); return; }
    editorRef.current?.focus();
    document.execCommand('insertHTML', false, `<p><br></p><p>—<br>${escapeHtml(signature).replace(/\n/g, '<br>')}</p>`);
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  }

  function insertEmoji(emoji: string) {
    editorRef.current?.focus();
    document.execCommand('insertText', false, emoji);
    if (editorRef.current) onChange(editorRef.current.innerHTML);
    setShowEmoji(false);
  }

  async function selectFiles(event: ChangeEvent<HTMLInputElement>, inline = false) {
    const selected = Array.from(event.target.files ?? []);
    event.currentTarget.value = '';
    onError('');
    if (attachments.length + selected.length > 10) { onError('Attach up to 10 files per message.'); return; }
    const currentSize = attachments.reduce((sum, item) => sum + item.size, 0);
    if (currentSize + selected.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) { onError('Attachments must total 10 MB or less.'); return; }
    try {
      const additions = await Promise.all(selected.map(async (file) => {
        if (inline && !file.type.startsWith('image/')) throw new Error('Choose an image file to insert into the message.');
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('Could not read one of the selected files.'));
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
          reader.readAsDataURL(file);
        });
        return { fileName: file.name, contentType: file.type || 'application/octet-stream', size: file.size, contentBase64, inline, ...(inline ? { contentId: crypto.randomUUID() } : {}) };
      }));
      onAttachmentsChange([...attachments, ...additions]);
      if (inline) {
        for (const image of additions) {
          editorRef.current?.focus();
          document.execCommand('insertHTML', false, `<img src="cid:${image.contentId}" alt="${escapeHtml(image.fileName)}" />`);
        }
        if (editorRef.current) onChange(editorRef.current.innerHTML);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not read the selected files.');
    }
  }

  return <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <header className="flex h-11 items-center justify-between bg-slate-50 px-4">
      <h2 className="text-xs font-semibold text-slate-800">New Message</h2>
      <div className="flex items-center gap-1"><span className="mr-2 text-[10px] text-slate-400">Rich text</span><ToolbarButton label={minimized ? 'Restore composer' : 'Minimize composer'} onClick={() => onMinimizeChange(!minimized)}>{minimized ? <Maximize2 size={15} /> : <Minus size={15} />}</ToolbarButton><ToolbarButton label={expanded ? 'Restore composer size' : 'Expand composer'} onClick={() => onExpandedChange(!expanded)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</ToolbarButton><ToolbarButton label="Close composer" onClick={onClose}><X size={15} /></ToolbarButton></div>
    </header>
    {!minimized && <>
    <div className="flex flex-wrap items-center gap-0.5 border-y border-slate-100 bg-slate-50/80 px-2 py-1.5" role="toolbar" aria-label="Message formatting">
      <ToolbarButton label="Undo" onClick={() => command('undo')}><Undo2 size={16} /></ToolbarButton>
      <ToolbarButton label="Redo" onClick={() => command('redo')}><Redo2 size={16} /></ToolbarButton>
      <span className="mx-1 h-5 border-l border-slate-300" />
      <label className="sr-only" htmlFor="compose-font">Font family</label>
      <select id="compose-font" aria-label="Font family" defaultValue="Arial" onChange={(event) => command('fontName', event.target.value)} className="h-8 max-w-32 rounded-md border-0 bg-transparent px-2 text-xs text-slate-700 hover:bg-slate-200 focus:ring-2 focus:ring-emerald-500">
        {['Arial', 'Georgia', 'Tahoma', 'Times New Roman', 'Verdana', 'Courier New'].map((font) => <option key={font}>{font}</option>)}
      </select>
      <label className="sr-only" htmlFor="compose-size">Text size</label>
      <select id="compose-size" aria-label="Text size" defaultValue="3" onChange={(event) => command('fontSize', event.target.value)} className="h-8 w-16 rounded-md border-0 bg-transparent px-2 text-xs text-slate-700 hover:bg-slate-200 focus:ring-2 focus:ring-emerald-500">
        <option value="2">Small</option><option value="3">Normal</option><option value="4">Large</option><option value="5">Huge</option>
      </select>
      <span className="mx-1 h-5 border-l border-slate-300" />
      <ToolbarButton label="Bold" onClick={() => command('bold')}><Bold size={16} /></ToolbarButton>
      <ToolbarButton label="Italic" onClick={() => command('italic')}><Italic size={16} /></ToolbarButton>
      <ToolbarButton label="Underline" onClick={() => command('underline')}><Underline size={16} /></ToolbarButton>
      <ToolbarButton label="Strikethrough" onClick={() => command('strikeThrough')}><Strikethrough size={16} /></ToolbarButton>
      <label className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-slate-600 hover:bg-slate-200" title="Text color"><Type size={16} /><input aria-label="Text color" type="color" className="sr-only" onChange={(event) => command('foreColor', event.target.value)} /></label>
      <span className="mx-1 h-5 border-l border-slate-300" />
      <ToolbarButton label="Align left" onClick={() => command('justifyLeft')}><AlignLeft size={16} /></ToolbarButton>
      <ToolbarButton label="Align center" onClick={() => command('justifyCenter')}><AlignCenter size={16} /></ToolbarButton>
      <ToolbarButton label="Align right" onClick={() => command('justifyRight')}><AlignRight size={16} /></ToolbarButton>
      <ToolbarButton label="Numbered list" onClick={() => command('insertOrderedList')}><ListOrdered size={16} /></ToolbarButton>
      <ToolbarButton label="Bulleted list" onClick={() => command('insertUnorderedList')}><List size={16} /></ToolbarButton>
      <ToolbarButton label="Decrease indent" onClick={() => command('outdent')}><Outdent size={16} /></ToolbarButton>
      <ToolbarButton label="Increase indent" onClick={() => command('indent')}><Indent size={16} /></ToolbarButton>
      <ToolbarButton label="Quote" onClick={() => command('formatBlock', 'blockquote')}><Quote size={16} /></ToolbarButton>
      <ToolbarButton label="Remove formatting" onClick={() => command('removeFormat')}><X size={16} /></ToolbarButton>
    </div>
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Email message body"
      aria-multiline="true"
      data-placeholder="Write your message…"
      className="compose-editor min-h-[260px] px-4 py-4 text-sm leading-6 text-slate-800 outline-none"
      onInput={(event) => onChange(event.currentTarget.innerHTML)}
      onBlur={(event) => onChange(event.currentTarget.innerHTML)}
    />
    {attachments.length > 0 && <ul aria-label="Attached files" className="flex flex-wrap gap-2 border-t border-slate-100 px-4 py-3">{attachments.map((file, index) => <li key={`${file.fileName}-${index}`} className="flex max-w-full items-center gap-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[10px] text-slate-700"><Paperclip size={12} /><span className="max-w-[220px] truncate">{file.fileName}</span><span className="text-slate-400">{formatBytes(file.size)}</span><button type="button" aria-label={`Remove ${file.fileName}`} onClick={() => onAttachmentsChange(attachments.filter((_, itemIndex) => itemIndex !== index))} className="ml-1 rounded p-0.5 hover:bg-slate-200"><X size={12} /></button></li>)}</ul>}
    <footer className="flex flex-wrap items-center gap-1 border-t border-slate-100 px-3 py-2">
      <ToolbarButton label="Attach files" onClick={() => fileRef.current?.click()}><Paperclip size={17} /></ToolbarButton>
      <input ref={fileRef} className="sr-only" type="file" multiple aria-label="Attach files" onChange={(event) => void selectFiles(event)} />
      <ToolbarButton label="Insert link" onClick={addLink}><Link2 size={17} /></ToolbarButton>
      <div className="relative"><ToolbarButton label="Insert emoji" onClick={() => setShowEmoji((open) => !open)}><Smile size={17} /></ToolbarButton>{showEmoji && <div className="absolute bottom-10 left-0 z-10 grid w-48 grid-cols-5 gap-1 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">{emojis.map((emoji) => <button key={emoji} type="button" onClick={() => insertEmoji(emoji)} className="rounded-lg p-2 text-lg hover:bg-slate-100" aria-label={`Insert ${emoji}`}>{emoji}</button>)}</div>}</div>
      <ToolbarButton label="Insert image in message" onClick={() => imageRef.current?.click()}><ImageIcon size={17} /></ToolbarButton>
      <input ref={imageRef} className="sr-only" type="file" accept="image/*" multiple aria-label="Insert image in message" onChange={(event) => void selectFiles(event, true)} />
      <ToolbarButton label="Attach from Google Drive (setup required)" onClick={() => onError('Google Drive needs its API enabled and a separate Drive permission added to Google sign-in.') }><Cloud size={17} /></ToolbarButton>
      <ToolbarButton label="Confidential mode unavailable with Ethereal" onClick={() => onError('Confidential mode is a Gmail feature. Ethereal test delivery cannot enforce message expiration or recipient restrictions.') }><LockKeyhole size={17} /></ToolbarButton>
      <ToolbarButton label="Insert sender signature" onClick={addSignature}><span className="text-base font-semibold">✎</span></ToolbarButton>
      <div className="relative ml-auto"><ToolbarButton label="More compose actions" onClick={() => setShowMore((open) => !open)}><MoreHorizontal size={18} /></ToolbarButton>{showMore && <div className="absolute bottom-10 right-0 z-10 min-w-48 rounded-xl border border-slate-200 bg-white p-1 shadow-lg"><button type="button" onClick={() => { command('selectAll'); command('copy'); setShowMore(false); }} className="w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50">Copy message text</button><button type="button" onClick={() => { command('removeFormat'); setShowMore(false); }} className="w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50">Clear formatting</button><div className="px-3 py-2 text-[10px] text-slate-400">Confidential mode and Drive attachments need additional Google services.</div></div>}</div>
    </footer>
    </>}
  </section>;
}

function ToolbarButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} onMouseDown={(event) => event.preventDefault()} onClick={onClick} className={toolbarButton}>{children}</button>;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatBytes(value: number) {
  return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
