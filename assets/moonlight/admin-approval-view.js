function isLinuxHostRebootRequest(item) {
  return item?.program === '/usr/bin/systemctl'
    && Array.isArray(item?.args)
    && item.args.length === 2
    && item.args[0] === '--no-block'
    && item.args[1] === 'reboot'
    && !item.cwd;
}
function isLinuxAptInstallRequest(item) {
  const packages = Array.isArray(item?.args) ? item.args.slice(2) : [];
  return item?.program === '/usr/bin/apt-get'
    && (!item.cwd || item.cwd === '/')
    && item.args?.[0] === 'install'
    && item.args?.[1] === '-y'
    && packages.length >= 1
    && packages.length <= 32
    && packages.every((value) => /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/.test(value));
}
function isLinuxApprovableRequest(item) {
  return isLinuxHostRebootRequest(item) || isLinuxAptInstallRequest(item);
}
function linuxApprovalPrompt(item) {
  return isLinuxHostRebootRequest(item)
    ? 'Approve this exact Linux reboot request? The host will reboot.'
    : 'Approve this exact Linux package installation request? System packages will be modified.';
}

export { isLinuxHostRebootRequest, isLinuxAptInstallRequest, isLinuxApprovableRequest, linuxApprovalPrompt };
