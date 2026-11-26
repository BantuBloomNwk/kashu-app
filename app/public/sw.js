// Kashu's service worker: it only shows notifications Kashu's keeper sends (a win, the draw), and opens the app when
// one is tapped. It caches nothing and touches no money.
self.addEventListener('push', (event) => {
  let n = { title: 'Kashu', body: 'Something happened in your room.', url: '/#app-room' };
  try { n = { ...n, ...event.data.json() }; } catch { /* plain notice */ }
  event.waitUntil(self.registration.showNotification(n.title, { body: n.body, icon: '/brand/icon-192.png', badge: '/brand/icon-192.png', data: { url: n.url }, tag: n.tag || 'kashu' }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/#app-room', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
    const open = all.find((c) => c.url.startsWith(self.location.origin));
    return open ? open.focus().then((c) => c.navigate(url)) : self.clients.openWindow(url);
  }));
});
