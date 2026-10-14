/** Tapehead shared state + persistence helpers — extracted module (v1.11 maturity)
 *  Loaded before app.js. Exposes window.state, window.scheduleSave, window.$, window.on, window.makeStableId
 */
(function () {
'use strict';
const $=id=>document.getElementById(id);const on=(id,ev,fn)=>{const el=$(id);if(el)el.addEventListener(ev,fn)};
window.$=$;window.on=on;
const makeStableId=(prefix='id_')=>{try{if(crypto&&crypto.randomUUID)return prefix+crypto.randomUUID();}catch(e){}return prefix+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,9)};const state={writeSections:null,writeSectionId:null,theme:localStorage.getItem('th-theme')||'dark',view:'write',studioView:'beat',bpm:120,octave:3,scale:'chromatic',keysSound:'piano',keysSustain:false,keysVelocity:.85,keysRecording:false,keysTake:[],_keyVoices:{},_keyStartedAt:0,kit:'trap',samples:{},pan:{kick:0,snare:0,hat:0,clap:0,chords:0,vocal:0},eq:{low:50,mid:50,high:50},glue:40,playing:false,currentStep:0,songs:[],currentSongId:null,stepCount:16,swing:0,pattern:{kick:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],snare:[0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0],hat:[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],clap:[0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0]},volumes:{kick:.85,snare:.7,hat:.45,clap:.6,master:.78},detectedChords:[],vocalTakes:[],recording:false,mediaRecorder:null,artistName:'Artist',user:null,guest:false,_pendingAvatar:null,pro:null,collabCode:null};
// Persist the active page so a browser refresh restores the same workspace.
try {
  const savedView = localStorage.getItem('th-view');
  const savedStudioView = localStorage.getItem('th-studio-view');
  const validViews = ['write','keys','beat','record','mix','community','collab'];
  const validStudioViews = ['keys','beat','record','mix'];
  if (savedView && validViews.includes(savedView)) state.view = savedView;
  if (savedStudioView && validStudioViews.includes(savedStudioView)) state.studioView = savedStudioView;
} catch (e) {}
window.state=state;let saveTimer;function scheduleSave(){
  clearTimeout(saveTimer);
  try{
    const dot=document.getElementById('saveDot');if(dot)dot.classList.remove('on');
    const pc=document.getElementById('pcSaveStatus');
    if(pc){pc.textContent='Unsaved changes…';pc.classList.add('dirty');pc.classList.remove('cloud');}
  }catch(e){}
  saveTimer=setTimeout(function(){try{(window.saveCurrentSong||function(){})()}catch(e){}try{(window.updateProjectContext||function(){})(true)}catch(e){}},600);
}

window.makeStableId=makeStableId;
window.scheduleSave=scheduleSave;

})();
