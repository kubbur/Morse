// Desktop-only labels. The training application is otherwise unchanged.
const byId = id => document.getElementById(id);
byId('callsign-intro-dialog').querySelector('.eyebrow').textContent = 'MORSE';
byId('intro-callsign-help').textContent = 'Optional. This desktop app keeps your callsign and progress on this Mac.';
byId('join-leaderboard').firstChild.textContent = 'Save callsign ';
byId('callsign-help').textContent = 'Saved on this Mac. Export progress to move it to the website or another device.';
document.querySelector('.callsign-listing').hidden = true;
document.querySelector('.leaderboard-card').hidden = true;
byId('pair-devices').hidden = true;
byId('pair-devices').closest('section').hidden = true;
document.querySelector('#progress-dialog > .dialog-note:last-child').textContent = 'This app works offline. The website’s device pairing and public leaderboard are separate from this desktop save.';
