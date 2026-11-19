if (!['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
  const build=Number(document.querySelector('meta[name="honeymoon-build"]')?.content);
  if (Number.isSafeInteger(build) && build>0) {
    const dialog=document.getElementById('solo-entry');
    const archiveName=build>=19?'Lilium-Moonlight':'Honeymoon';
    document.getElementById('solo-entry-download').href=
      `https://github.com/MoondancerDW/Honeymoon/releases/download/build-${build}/${archiveName}-Build-${build}-SinglePlayer.zip`;
    for (const button of document.querySelectorAll('.solo-entry-button')) {
      button.addEventListener('click',()=>dialog.showModal());
      button.hidden=false;
    }
  }
}
