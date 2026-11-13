const marks = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  timeline: '<path d="M6 5v14M12 6h8m-8 6h6m-6 6h8"/><circle cx="6" cy="5" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="6" cy="19" r="1.5"/>',
  health: '<path d="M3 7.5a4.6 4.6 0 0 1 8.9-1.4A4.7 4.7 0 0 1 21 7.5c0 4.1-4.3 7.7-9 11.7C7.3 15.2 3 11.6 3 7.5Z"/><path d="M5 11h4l1.5-3 2.4 6 1.8-3H19"/>',
  profile: '<rect x="5" y="3" width="15" height="18" rx="3"/><circle cx="12.5" cy="10" r="2.4"/><path d="M8.5 16.8c.8-2.8 7.2-2.8 8 0M3.5 7H6m-2.5 5H6m-2.5 5H6"/>',
  feed: '<g transform="rotate(34 12 12)"><path d="M8 9h8v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2z"/><rect x="7" y="6.5" width="10" height="3" rx="1"/><path d="M9.5 6.5V5c0-.9.6-1.4 1.2-1.6V2.8a1.3 1.3 0 0 1 2.6 0v.6c.6.2 1.2.7 1.2 1.6v1.5M8.5 13h3m-3 3h2"/></g>',
  sleep: '<path d="M20.3 14A8.6 8.6 0 0 1 9.8 3.5 8.9 8.9 0 1 0 20.3 14Z"/><path d="m16.3 3.5.4 1.3 1.3.4-1.3.4-.4 1.3-.4-1.3-1.3-.4 1.3-.4z"/>',
  pee: '<path d="M12 2.7C9.4 6.5 5.5 10.9 5.5 14.8a6.5 6.5 0 0 0 13 0C18.5 10.9 14.6 6.5 12 2.7Z"/><path d="M8.8 15.3a3.3 3.3 0 0 0 3.1 3.1"/>',
  poop: '<path d="M3.3 6.5h17.4v4.2c0 4.4-4.3 8.2-8.7 8.2s-8.7-3.8-8.7-8.2V6.5Zm.3 3.8h16.8m-16 2.9c2.6-.1 5 2.1 5.4 4.7m9.7-4.7c-2.7-.1-4.9 2.1-5.3 4.7"/>',
  med: '<path d="m5.3 11.8 6.5-6.5a4.9 4.9 0 0 1 7 7l-6.5 6.5a4.9 4.9 0 0 1-7-7Zm3.2-3.2 7 7m-1.2-9.1a2.6 2.6 0 0 1 3.2.4"/>',
  supplement: '<rect x="6.5" y="8" width="11" height="12.5" rx="2.2"/><path d="M8.5 8V4h7v4M9 3.5h6m-5.5 10H15m-2.8-2.7v5.4"/>',
  temperature: '<path d="M10 5a2.5 2.5 0 0 1 5 0v8.8a4.1 4.1 0 1 1-5 0V5Zm2.5 3v8.5m4.8-10.8h2.2m-2.2 3.7h1.5"/><circle cx="12.5" cy="17" r="1"/>',
  vaccine: '<g transform="rotate(44 12 12)"><path d="M9 7h6v9a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V7ZM7 7h10M12 3v4m-2-4h4m-2 14v4m-3-10h2m-2 3h2"/></g>',
  growth: '<g transform="rotate(40 12 12)"><rect x="8" y="2" width="8" height="20" rx="1.5"/><path d="M8 6h3m-3 4h2m-2 4h3m-3 4h2"/></g>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="3"/><path d="M7.5 3v4m9-4v4M4 10h16M8 14h2m4 0h2"/>',
  photo: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="m4 17 5-5 3.2 3.2 2.2-2.2 5 5"/><circle cx="15.5" cy="9.5" r="1.3"/>',
  arrow: '<path d="M4 12h15m-5.3-5.3 5.4 5.3-5.4 5.3"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  prev: '<path d="m15 5-7 7 7 7"/>',
  plus: '<path d="M12 5v14m-7-7h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  edit: '<path d="m5 15 10.7-10.7a1.9 1.9 0 0 1 2.7 0l1.3 1.3a1.9 1.9 0 0 1 0 2.7L9 19l-5 1zM14 6l4 4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  family: '<circle cx="9" cy="8" r="2.9"/><path d="M3.3 19v-1.3a5.7 5.7 0 0 1 11.4 0V19m1.4-13a2.9 2.9 0 0 1 0 5.8m1.5 2.6a5 5 0 0 1 3.2 4.6"/>',
  flower: '<g stroke-width="1.35"><path d="M12 10.2C7.7 7.8 8.2 2.9 11.1 2.4c2.9-.6 5 3.2 2.2 7.8m.6.6c1.4-3.6 5.4-4.4 7.1-2.1 1.9 2.7-.4 5.7-6.5 5m-.3 1c4.1.5 5.8 4.3 3.7 6.3-2.7 2.2-6.1.5-6.7-5.4m-1-.2c.3 4.5-3.2 6.5-5.6 4.9-2.7-2.1-1.6-6 4.1-7.4m-.2-.9c-3.8 2-7 .1-6.9-2.7.1-3.4 4.8-4.6 8.2-.3"/><circle cx="11.7" cy="12.4" r="2"/></g>'
};
const aliases = {milk:'feed', history:'timeline', medication:'med', stats:'health'};
export function icon(type) {
  const shape = marks[aliases[type] || type] || marks.timeline;
  return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + shape + '</svg>';
}
export function hydrateIcons(scope = document) {
  for (const placeholder of scope.querySelectorAll('[data-icon]')) {
    placeholder.innerHTML = icon(placeholder.dataset.icon);
  }
}
