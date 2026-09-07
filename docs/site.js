const button = document.querySelector('#copy-install');
const command = document.querySelector('#install-command');
const status = document.querySelector('#copy-status');

button?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(command.textContent.trim());
    button.textContent = 'Copied';
    status.textContent = 'Paste it into Termux and press Enter.';
  } catch {
    const selection = getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(command);
    selection.addRange(range);
    status.textContent = 'Command selected. Copy it, then paste it into Termux.';
  }
});
