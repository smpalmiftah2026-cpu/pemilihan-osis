/* global supabase, Chart, XLSX, APP_CONFIG */
const $ = (id) => document.getElementById(id);
const cfg = window.APP_CONFIG || {};
const isConfigured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR_PROJECT_ID') && cfg.SUPABASE_PUBLISHABLE_KEY && !cfg.SUPABASE_PUBLISHABLE_KEY.includes('YOUR_');
const sb = isConfigured ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY) : null;

const state = {
  user: null, profile: null, unit: 'SMP', election: null,
  students: [], candidates: [], votes: [], voteCards: [],
  currentStudent: null, excelRows: [], resultChart: null, pieChart: null,
  rfidBuffer: '', rfidLastKeyAt: 0, votingLocked: false
};

const viewTitles = {
  dashboard: ['SISTEM PEMILIHAN', 'Dashboard'], students: ['DATA PESERTA', 'Data Siswa'],
  candidates: ['MANAJEMEN PASLON', 'Kandidat OSIS'], kiosk: ['BILIK SUARA', 'Pemilihan RFID'],
  calling: ['ANTRIAN PEMILIH', 'Pemanggilan Siswa'], import: ['DATA PESERTA', 'Import Excel'],
  settings: ['PERANGKAT PEMILIHAN', 'Pengaturan RFID']
};

function toast(message, type='') {
  const el = $('toast'); el.textContent = message; el.className = `toast show ${type}`;
  clearTimeout(toast._t); toast._t = setTimeout(() => el.className = 'toast', 3500);
}
function esc(s='') { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c])); }
function pct(a,b){ return b ? ((a/b)*100).toFixed(1).replace('.',',')+'%' : '0%'; }
function formatDate(d=new Date()){ return new Intl.DateTimeFormat('id-ID',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}).format(d); }
function speak(text){ if(!('speechSynthesis' in window)) return; speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(text); u.lang='id-ID'; u.rate=.92; speechSynthesis.speak(u); }
function isAdmin(){ return state.profile?.role === 'admin'; }
function selectedElectionId(){ return state.election?.id; }

async function init(){
  tickClock(); setInterval(tickClock, 1000); bindEvents();
  if(!isConfigured){ toast('Isi SUPABASE_URL dan SUPABASE_PUBLISHABLE_KEY di config.js terlebih dahulu.', 'error'); return; }
  const { data:{session} } = await sb.auth.getSession();
  if(session?.user) await afterLogin(session.user);
  sb.auth.onAuthStateChange(async (_event, session) => { if(!session){ showLogin(); } });
}
function tickClock(){ const d=new Date(); $('dateNow').textContent=formatDate(d); $('clockNow').textContent=d.toLocaleTimeString('id-ID'); }
function showLogin(){ $('loginView').classList.remove('hidden'); $('appView').classList.add('hidden'); state.user=null; }
async function afterLogin(user){
  state.user=user;
  const {data:profile,error}=await sb.from('profiles').select('user_id,full_name,role').eq('user_id',user.id).single();
  if(error || !profile){ toast('Akun Auth ada, tetapi belum terdaftar di tabel profiles.', 'error'); await sb.auth.signOut(); return; }
  state.profile=profile; $('profileMini').innerHTML=`<b>${esc(profile.full_name||user.email)}</b><br>${esc(profile.role)}`;
  $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden');
  document.querySelector('[data-view="candidates"]').style.display=isAdmin()?'':'none';
  document.querySelector('[data-view="import"]').style.display=isAdmin()?'':'none';
  document.querySelector('[data-view="settings"]').style.display=isAdmin()?'':'none';
  await loadUnit();
}
async function loadUnit(){
  const {data,error}=await sb.from('elections').select('*').eq('unit',state.unit).eq('is_active',true).maybeSingle();
  if(error || !data){ state.election=null; toast(`Pemilihan aktif untuk ${state.unit} belum ada. Jalankan SQL setup.`, 'error'); return; }
  state.election=data;
  $('heroTitle').textContent=`${state.unit} AL-MIFTAH`; $('kioskUnitTitle').textContent=`${state.unit} AL-MIFTAH`;
  await Promise.all([loadStudents(),loadCandidates(),loadVotes(),loadVoteCards()]); renderAll();
}
async function loadStudents(){
  const {data,error}=await sb.from('students').select('id,nisn,name,class_name,voted_at,called_at').eq('election_id',selectedElectionId()).order('class_name').order('name');
  if(error){ toast(error.message,'error'); return; } state.students=data||[];
}
async function loadCandidates(){
  const {data,error}=await sb.from('candidates').select('*').eq('election_id',selectedElectionId()).eq('active',true).order('ballot_code');
  if(error){ toast(error.message,'error'); return; } state.candidates=data||[];
}
async function loadVotes(){
  const {data,error}=await sb.from('votes').select('id,candidate_id,student_id,created_at').eq('election_id',selectedElectionId());
  if(error){ toast(error.message,'error'); return; } state.votes=data||[];
}
async function loadVoteCards(){
  if(!isAdmin()){ state.voteCards=[]; return; }
  const {data,error}=await sb.from('vote_cards').select('id,candidate_id,tag_uid').eq('election_id',selectedElectionId());
  if(error){ console.warn(error); state.voteCards=[]; return; } state.voteCards=data||[];
}
function renderAll(){ renderDashboard(); renderStudents(); renderCandidates(); renderKiosk(); renderCalling(); renderRFIDSettings(); }

function renderDashboard(){
  const total=state.students.length, voted=state.students.filter(s=>s.voted_at).length, remaining=total-voted;
  $('statTotal').textContent=total; $('statVoted').textContent=voted; $('statRemaining').textContent=remaining; $('statCandidates').textContent=state.candidates.length;
  $('statVotedPct').textContent=pct(voted,total); $('statRemainingPct').textContent=pct(remaining,total);
  const labels=state.candidates.map(c=>`Paslon ${c.ballot_code}`), values=state.candidates.map(c=>state.votes.filter(v=>v.candidate_id===c.id).length);
  if(state.resultChart) state.resultChart.destroy();
  if(state.pieChart) state.pieChart.destroy();
  state.resultChart=new Chart($('resultChart'),{type:'bar',data:{labels,datasets:[{label:'Jumlah Suara',data:values,backgroundColor:['#147be8','#15a36d','#7c4fe0','#ff9f2f'],borderRadius:8}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{precision:0}}}}});
  state.pieChart=new Chart($('pieChart'),{type:'doughnut',data:{labels,datasets:[{data:values,backgroundColor:['#147be8','#15a36d','#7c4fe0','#ff9f2f'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:'64%',plugins:{legend:{position:'bottom'}}}});
}
function renderStudents(filter=''){
  const q=filter.toLowerCase();
  const rows=state.students.filter(s=>!q || [s.name,s.nisn,s.class_name].some(x=>String(x||'').toLowerCase().includes(q)));
  $('studentsTableBody').innerHTML=rows.length?rows.map(s=>`<tr><td>${esc(s.nisn)}</td><td><b>${esc(s.name)}</b></td><td>${esc(s.class_name)}</td><td>${s.voted_at?'<span class="badge ok">Sudah memilih</span>':'<span class="badge pending">Belum memilih</span>'}</td></tr>`).join(''):'<tr><td colspan="4" class="muted">Belum ada data siswa.</td></tr>';
  const classes=[...new Set(state.students.map(s=>s.class_name).filter(Boolean))].sort();
  const current=$('callClass').value; $('callClass').innerHTML='<option value="">Semua kelas</option>'+classes.map(c=>`<option ${c===current?'selected':''}>${esc(c)}</option>`).join('');
}
function renderCandidates(){
  $('candidateCards').innerHTML=state.candidates.length?state.candidates.map(c=>`<div class="candidate-card">${c.photo_url?`<img src="${esc(c.photo_url)}" alt="Paslon ${esc(c.ballot_code)}">`:`<div class="candidate-placeholder">${esc(c.ballot_code)}</div>`}<div><h4>Paslon ${esc(c.ballot_code)} — ${esc(c.chair_name)}</h4><p>Wakil: ${esc(c.vice_name)}</p><p>${esc(c.vision)}</p>${isAdmin()?`<div class="candidate-actions"><button data-edit-candidate="${c.id}">Edit</button><button data-delete-candidate="${c.id}">Hapus</button></div>`:''}</div></div>`).join(''):'<p class="muted">Belum ada kandidat.</p>';
  $('rfidCandidate').innerHTML=state.candidates.map(c=>`<option value="${c.id}">Paslon ${esc(c.ballot_code)} — ${esc(c.chair_name)}</option>`).join('');
}
function renderKiosk(){
  $('kioskCandidateCards').innerHTML=state.candidates.map(c=>{
    const theme=`theme-${String(c.ballot_code||'').toLowerCase()}`;
    return `<article class="kiosk-candidate ${theme}"><div class="photo-area">${c.photo_url?`<img src="${esc(c.photo_url)}" alt="Paslon ${esc(c.ballot_code)}">`:`<div class="candidate-placeholder">PASLON ${esc(c.ballot_code)}</div>`}</div><div class="content"><span class="code">${esc(c.ballot_code)}</span><h3>${esc(c.chair_name)}</h3><p>Wakil: <b>${esc(c.vice_name)}</b></p><p><b>Visi:</b> ${esc(c.vision)}</p><div class="badge vote-badge">Pilih dengan kartu RFID ${esc(c.ballot_code)}</div></div></article>`;
  }).join('');
  if(state.currentStudent){
    $('currentStudentCard').classList.remove('empty'); $('currentStudentName').textContent=state.currentStudent.name; $('currentStudentMeta').textContent=`NISN: ${state.currentStudent.nisn} • Kelas: ${state.currentStudent.class_name}`;
  } else { $('currentStudentCard').classList.add('empty'); $('currentStudentName').textContent='Belum ada siswa dipanggil'; $('currentStudentMeta').textContent='Buka menu Pemanggilan Siswa lalu pilih siswa.'; }
}
function renderCalling(){
  if(state.currentStudent){ $('calledName').textContent=state.currentStudent.name; $('calledMeta').textContent=`NISN: ${state.currentStudent.nisn} • Kelas: ${state.currentStudent.class_name}`; $('calledVoteStatus').textContent=state.currentStudent.voted_at?'Sudah memilih':'Menunggu memilih'; $('calledVoteStatus').className=`status-pill ${state.currentStudent.voted_at?'ok':'warn'}`; }
  else { $('calledName').textContent='Belum ada'; $('calledMeta').textContent='Pilih kelas lalu tekan tombol panggil.'; $('calledVoteStatus').textContent='Menunggu'; $('calledVoteStatus').className='status-pill'; }
}
function renderRFIDSettings(){
  if(!isAdmin()) return;
  $('rfidConfigList').innerHTML=state.candidates.map(c=>{ const card=state.voteCards.find(v=>v.candidate_id===c.id); return `<div class="info-box small"><b>Paslon ${esc(c.ballot_code)}</b><br>${card?`UID terdaftar: <code>${esc(card.tag_uid)}</code>`:'Belum ada kartu RFID terdaftar'}</div>`; }).join('')||'<p class="muted">Tambahkan kandidat terlebih dahulu.</p>';
}

function showView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active')); $(`${name}View`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  const [ey,title]=viewTitles[name]; $('pageEyebrow').textContent=ey; $('pageTitle').textContent=title;
}

function bindEvents(){
  $('loginForm').addEventListener('submit',async e=>{ e.preventDefault(); if(!sb){toast('Supabase belum dikonfigurasi.','error');return;} const {data,error}=await sb.auth.signInWithPassword({email:$('loginEmail').value.trim(),password:$('loginPassword').value}); if(error)toast(error.message,'error'); else await afterLogin(data.user); });
  $('logoutBtn').addEventListener('click',()=>sb.auth.signOut());
  $('mainNav').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(b)showView(b.dataset.view);});
  $('openKioskBtn').addEventListener('click',()=>showView('kiosk'));
  $('unitSelect').addEventListener('change',async e=>{state.unit=e.target.value;state.currentStudent=null;await loadUnit();});
  $('refreshDashboardBtn').addEventListener('click',loadUnit);
  $('studentSearch').addEventListener('input',e=>renderStudents(e.target.value));
  $('candidateForm').addEventListener('submit',saveCandidate); $('resetCandidateBtn').addEventListener('click',resetCandidateForm);
  $('candidateCards').addEventListener('click',candidateAction);
  $('callNextBtn').addEventListener('click',callNextStudent); $('skipBtn').addEventListener('click',()=>{state.currentStudent=null;renderKiosk();renderCalling();callNextStudent();});
  $('chooseExcelBtn').addEventListener('click',()=>$('excelFile').click()); $('excelFile').addEventListener('change',e=>parseExcel(e.target.files[0])); $('importExcelBtn').addEventListener('click',importExcel);
  const dz=$('dropZone'); ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag')})); ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag')})); dz.addEventListener('drop',e=>parseExcel(e.dataTransfer.files[0]));
  $('rfidCardForm').addEventListener('submit',saveRFIDCard);
  window.addEventListener('keydown',rfidKeyListener,true);
}

async function saveCandidate(e){
  e.preventDefault(); if(!isAdmin())return;
  let photoUrl=null; const file=$('candidatePhoto').files[0];
  if(file){ const path=`${selectedElectionId()}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`; const {error:upErr}=await sb.storage.from(cfg.STORAGE_BUCKET||'candidate-photos').upload(path,file,{cacheControl:'3600',upsert:false}); if(upErr){toast('Upload foto gagal: '+upErr.message,'error');return;} photoUrl=sb.storage.from(cfg.STORAGE_BUCKET||'candidate-photos').getPublicUrl(path).data.publicUrl; }
  const payload={election_id:selectedElectionId(),ballot_code:$('ballotCode').value,chair_name:$('chairName').value.trim(),vice_name:$('viceName').value.trim(),vision:$('candidateVision').value.trim(),active:true}; if(photoUrl)payload.photo_url=photoUrl;
  const id=$('candidateId').value; let error;
  if(id)({error}=await sb.from('candidates').update(payload).eq('id',id)); else ({error}=await sb.from('candidates').insert(payload));
  if(error){toast(error.message,'error');return;} toast('Kandidat berhasil disimpan.','success');resetCandidateForm();await loadCandidates();await loadVotes();renderAll();
}
function resetCandidateForm(){ $('candidateForm').reset();$('candidateId').value='';$('ballotCode').value='A'; }
async function candidateAction(e){
  const edit=e.target.dataset.editCandidate, del=e.target.dataset.deleteCandidate;
  if(edit){ const c=state.candidates.find(x=>x.id===edit); $('candidateId').value=c.id;$('ballotCode').value=c.ballot_code;$('chairName').value=c.chair_name;$('viceName').value=c.vice_name;$('candidateVision').value=c.vision;window.scrollTo({top:0,behavior:'smooth'}); }
  if(del&&confirm('Hapus kandidat ini?')){ const {error}=await sb.from('candidates').update({active:false}).eq('id',del); if(error)toast(error.message,'error'); else {toast('Kandidat dinonaktifkan.','success');await loadCandidates();renderAll();} }
}

async function callNextStudent(){
  const cls=$('callClass').value; let pool=state.students.filter(s=>!s.voted_at && (!cls||s.class_name===cls));
  if(!pool.length){toast('Tidak ada siswa yang belum memilih pada filter ini.','error');return;}
  if($('callOrder').value==='random') pool=pool.sort(()=>Math.random()-.5); else pool=pool.sort((a,b)=>a.name.localeCompare(b.name,'id'));
  state.currentStudent=pool[0];
  const {error:callErr}=await sb.rpc('mark_student_called',{p_student_id:state.currentStudent.id});
  if(callErr) console.warn('Gagal menyimpan waktu panggilan:', callErr.message);
  renderCalling();renderKiosk();
  speak(`${state.currentStudent.name}, kelas ${state.currentStudent.class_name}, silakan menuju bilik pemilihan OSIS.`);
  toast(`Memanggil ${state.currentStudent.name}`,'success');
}

function rfidKeyListener(e){
  const tag=(e.target.tagName||'').toLowerCase(); const inField=['input','textarea','select'].includes(tag);
  if(inField) return; // Saat daftar kartu, biarkan reader mengetik langsung ke input.
  if(!$('kioskView').classList.contains('active')) return;
  const now=Date.now(); if(now-state.rfidLastKeyAt>500)state.rfidBuffer=''; state.rfidLastKeyAt=now;
  if(e.key==='Enter'){
    const uid=state.rfidBuffer.trim(); state.rfidBuffer=''; if(uid.length>=2)submitVote(uid); return;
  }
  if(e.key.length===1) state.rfidBuffer+=e.key;
}
async function submitVote(uid){
  if(state.votingLocked)return; if(!state.currentStudent){toast('Belum ada siswa yang dipanggil.','error');speak('Belum ada siswa yang dipanggil');return;}
  state.votingLocked=true; $('rfidState').textContent='Memproses kartu...'; $('rfidState').className='status-pill warn';
  const {data,error}=await sb.rpc('submit_vote',{p_student_id:state.currentStudent.id,p_tag_uid:uid});
  if(error || !data?.ok){ const msg=error?.message||data?.message||'Pemilihan gagal'; toast(msg,'error');speak('Pemilihan gagal'); $('rfidState').textContent='Kartu ditolak'; $('rfidState').className='status-pill warn'; state.votingLocked=false;return; }
  toast(`Suara untuk Paslon ${data.ballot_code} berhasil direkam.`,'success'); speak('Pilihan berhasil direkam. Terima kasih.'); $('rfidState').textContent=`Berhasil: Paslon ${data.ballot_code}`; $('rfidState').className='status-pill ok';
  await Promise.all([loadStudents(),loadVotes()]); state.currentStudent=null; renderAll(); setTimeout(()=>{ $('rfidState').textContent='Menunggu kartu RFID'; $('rfidState').className='status-pill warn'; state.votingLocked=false; },1500);
}

async function saveRFIDCard(e){
  e.preventDefault(); if(!isAdmin())return; const candidateId=$('rfidCandidate').value, uid=$('rfidUid').value.trim(); if(!candidateId||!uid)return;
  const {data:existing}=await sb.from('vote_cards').select('id').eq('election_id',selectedElectionId()).eq('candidate_id',candidateId).maybeSingle();
  let error; if(existing)({error}=await sb.from('vote_cards').update({tag_uid:uid}).eq('id',existing.id)); else ({error}=await sb.from('vote_cards').insert({election_id:selectedElectionId(),candidate_id:candidateId,tag_uid:uid}));
  if(error){toast(error.message,'error');return;} $('rfidUid').value='';toast('Kartu RFID paslon tersimpan.','success');await loadVoteCards();renderRFIDSettings();
}

function normalizeHeader(h){return String(h||'').trim().toLowerCase().replace(/\s+/g,' ')}
async function parseExcel(file){
  if(!file)return; try{ const buf=await file.arrayBuffer(); const wb=XLSX.read(buf,{type:'array'}); const ws=wb.Sheets[wb.SheetNames[0]]; const raw=XLSX.utils.sheet_to_json(ws,{defval:''});
    state.excelRows=raw.map(r=>{const obj={};Object.entries(r).forEach(([k,v])=>obj[normalizeHeader(k)]=v);return {nisn:String(obj['nisn']||obj['nis / nisn']||obj['nis']||'').trim(),name:String(obj['nama siswa']||obj['nama']||'').trim(),class_name:String(obj['kelas']||'').trim(),unit:String(obj['tingkat']||obj['jenjang']||'').trim().toUpperCase()};}).filter(r=>r.nisn&&r.name&&r.class_name);
    const preview=state.excelRows.slice(0,8); $('excelPreview').innerHTML=`<table><thead><tr><th>NISN</th><th>Nama</th><th>Kelas</th><th>Tingkat</th></tr></thead><tbody>${preview.map(r=>`<tr><td>${esc(r.nisn)}</td><td>${esc(r.name)}</td><td>${esc(r.class_name)}</td><td>${esc(r.unit||state.unit)}</td></tr>`).join('')}</tbody></table>`;
    $('importStatus').classList.remove('hidden');$('importStatus').textContent=`${state.excelRows.length} baris valid siap diimport ke ${state.unit}.`; $('importExcelBtn').disabled=!state.excelRows.length;
  }catch(err){toast('File Excel tidak dapat dibaca: '+err.message,'error');}
}
async function importExcel(){
  if(!isAdmin()||!state.excelRows.length)return; const rows=state.excelRows.filter(r=>!r.unit||r.unit===state.unit).map(r=>({election_id:selectedElectionId(),nisn:r.nisn,name:r.name,class_name:r.class_name}));
  if(!rows.length){toast(`Tidak ada baris yang cocok dengan tingkat ${state.unit}.`,'error');return;}
  $('importExcelBtn').disabled=true; const chunk=300; let total=0;
  for(let i=0;i<rows.length;i+=chunk){ const {error}=await sb.from('students').upsert(rows.slice(i,i+chunk),{onConflict:'election_id,nisn'}); if(error){toast('Import gagal: '+error.message,'error');$('importExcelBtn').disabled=false;return;} total+=Math.min(chunk,rows.length-i); }
  toast(`${total} siswa berhasil diimport/diperbarui.`,'success');state.excelRows=[];$('importExcelBtn').disabled=true;await loadStudents();renderAll();
}

document.addEventListener('DOMContentLoaded',init);
