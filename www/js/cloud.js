/** Auralith Cloud layer — extracted module (v1.11 maturity)
 *  Loaded before app.js. Assigns window.AuralithCloud.
 *  Runtime deps (resolved when methods run): window.state, window.saveSession,
 *  window.updateUserUI, window.lockApp, window.updateCloudBadge.
 */
(function () {
'use strict';
/* ── Phase C: Cloud layer (Supabase) with local fallback ── */
window.AuralithCloud = {
  sb: null,
  mode: 'local', // 'local' | 'cloud'
  roomChannel: null,
  feedChannel: null,
  messageChannel: null,
  followChannel: null,
  collabChatChannel: null,
  authSubscription: null,
  requireCloud: false,

  init() {
    const cfg = window.AURALITH_CLOUD || {};
    this.requireCloud = !!cfg.enabled;
    const lib = window.supabase || window.supabaseJs || null;
    const create = lib && (lib.createClient || (lib.default && lib.default.createClient));
    console.log('[Auralith] Cloud init check', {
      enabled: !!cfg.enabled,
      hasUrl: !!cfg.supabaseUrl,
      hasKey: !!cfg.supabaseAnonKey,
      hasLib: !!lib,
      hasCreate: !!create
    });
    if (cfg.enabled && cfg.supabaseUrl && cfg.supabaseAnonKey && create) {
      try {
        this.sb = create.call(lib, cfg.supabaseUrl, cfg.supabaseAnonKey);
        this.mode = 'cloud';
        try {
          this.authSubscription = this.sb.auth.onAuthStateChange((event, session) => {
            try {
              if (event === 'PASSWORD_RECOVERY') {
                try {
                  const m = document.getElementById('recoveryModal');
                  if (m) { m.classList.add('show'); m.style.display = 'flex'; m.style.opacity = '1'; m.style.pointerEvents = 'auto'; }
                } catch (e) {}
              } else if (event === 'SIGNED_OUT') {
                if (window.state) window.state.user = null;
                (window.saveSession||function(){})(null);
                (window.updateUserUI||function(){})();
                (window.lockApp||function(){})(true);
              } else if (session?.user && window.state && window.state.user?.cloudId === session.user.id) {
                (window.saveSession||function(){})({contact: session.user.email || window.state.user.contact, id: session.user.id, cloud: true});
              }
            } catch (e) { console.warn('[Auralith] auth state handler', e); }
          });
        } catch (e) { console.warn('[Auralith] auth listener unavailable', e); }
        console.log('[Auralith] Cloud mode (AIR)');
        try { (window.updateCloudBadge||function(){})(); } catch (e) {}
        return true;
      } catch (e) {
        console.warn('[Auralith] Cloud init failed, local mode', e);
      }
    } else {
      console.warn('[Auralith] Local mode — missing', {
        enabled: cfg.enabled,
        url: cfg.supabaseUrl ? 'ok' : 'missing',
        key: cfg.supabaseAnonKey ? 'ok' : 'missing',
        sdk: create ? 'ok' : 'missing'
      });
    }
    this.mode = this.requireCloud ? 'unavailable' : 'local';
    this.sb = null;
    try { (window.updateCloudBadge||function(){})(); } catch (e) {}
    return false;
  },

  
  async currentAuthUser() { if (!this.isCloud()) return null; try { const {data:sd}=await this.sb.auth.getSession(); if(sd&&sd.session&&sd.session.user) return sd.session.user; const {data}=await this.sb.auth.getUser(); return data?.user||null; } catch(e){ return null; } },
  async ensureProfile(user, username, contact) {
    if(!this.isCloud()||!user?.id)return null;
    const desired = String(username || user.user_metadata?.username || user.email?.split('@')[0] || 'Artist').trim().slice(0,24) || 'Artist';
    const row={id:user.id,username:desired,contact:contact||user.email||''};
    const {data,error}=await this.sb.from('profiles').upsert(row,{onConflict:'id'}).select('*').single();
    if(error){console.warn('ensureProfile',error);return null;} return data;
  },
  async updateProfile(userId, patch) {
    if(!this.isCloud()||!userId)return null;
    const safe={};
    ['username','contact','avatar_url','bio','location','genres','links','open_to_collab'].forEach(k=>{if(Object.prototype.hasOwnProperty.call(patch||{},k))safe[k]=patch[k];});
    const {data,error}=await this.sb.from('profiles').update({...safe,updated_at:new Date().toISOString()}).eq('id',userId).select('*').single();
    if(error){console.warn('updateProfile',error);return null;} try{if(window.state)window.state._profCache=null;}catch(e){} return data;
  },
  async toggleFollow(targetId, following) {
    if(!this.isCloud()||!targetId)return {following:false}; const user=await this.currentAuthUser(); if(!user||user.id===targetId)return {following:false};
    try { const r=following?await this.sb.from('follows').upsert({follower_id:user.id,following_id:targetId},{onConflict:'follower_id,following_id'}):await this.sb.from('follows').delete().eq('follower_id',user.id).eq('following_id',targetId); if(r.error)throw r.error; return {following}; } catch(e){console.warn('toggleFollow',e);return {following:!following,error:e.message};}
  },
  async isFollowing(targetId) { if(!this.isCloud()||!targetId)return false; const user=await this.currentAuthUser(); if(!user)return false; const {data}=await this.sb.from('follows').select('follower_id').eq('follower_id',user.id).eq('following_id',targetId).maybeSingle(); return !!data; },
  async getFollowStats(userId) { if(!this.isCloud()||!userId)return {followers:0,following:0}; const [a,b]=await Promise.all([this.sb.from('follows').select('*',{count:'exact',head:true}).eq('following_id',userId),this.sb.from('follows').select('*',{count:'exact',head:true}).eq('follower_id',userId)]); return {followers:a.count||0,following:b.count||0}; },
  async sendMessage(toId,body) {
    if(!this.isCloud()||!toId)return null;
    const user=await this.currentAuthUser();
    if(!user || user.id===toId)return null;
    const {data,error}=await this.sb.from('messages').insert({sender_id:user.id,recipient_id:toId,body:String(body).trim().slice(0,2000)}).select('*').single();
    if(error){console.warn('sendMessage',error);return null;} return data;
  },
  async fetchMessages() {
    if(!this.isCloud())return [];
    const user=await this.currentAuthUser(); if(!user)return [];
    const {data,error}=await this.sb.from('messages').select('*').or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`).order('created_at',{ascending:true}).limit(500);
    if(error){console.warn('fetchMessages',error);return [];} return data||[];
  },
  async markMessagesRead(peerId) { if(!this.isCloud()||!peerId)return; const user=await this.currentAuthUser(); if(!user)return; const {error}=await this.sb.rpc('mark_messages_read',{p_sender_id:peerId}); if(error) console.warn('markMessagesRead',error); },

  isCloud() { return this.mode === 'cloud' && this.sb; },
  requiresCloud() { return this.requireCloud; },

  async ensureSession() {
    if (!this.isCloud()) return null;
    const { data } = await this.sb.auth.getSession();
    return data?.session || null;
  },

  async signUp(email, password, username) {
    if (!this.isCloud()) return { error: 'Cloud services are temporarily unavailable' };
    const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    const redirect = isNative ? 'https://tapehead-pro-phi.vercel.app/' : window.location.origin + window.location.pathname;
    const { data, error } = await this.sb.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
    if (error) return { error: error.message };
    const uid = data.user?.id;
    if (uid) {
      await this.sb.from('profiles').upsert({
        id: uid,
        username: username || email.split('@')[0],
        contact: email.toLowerCase()
      });
    }
    return { user: data.user, session: data.session };
  },

  async signIn(email, password) {
    if (!this.isCloud()) return { error: 'Cloud services are temporarily unavailable' };
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { user: data.user, session: data.session };
  },

  async resetPassword(email) {
    if (!this.isCloud()) return { error: 'Cloud services are temporarily unavailable' };
    const { error } = await this.sb.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), { redirectTo: window.location.origin + window.location.pathname });
    return error ? { error: error.message } : { ok: true };
  },
  async updatePassword(password) {
    if (!this.isCloud()) return { error: 'Cloud services are temporarily unavailable' };
    const { error } = await this.sb.auth.updateUser({ password: String(password) });
    return error ? { error: error.message } : { ok: true };
  },

  async deleteAccount() {
    if (!this.isCloud()) return { error: 'Cloud account deletion is only available for Cloud accounts.' };
    const { data: { session } } = await this.sb.auth.getSession();
    if (!session?.access_token) return { error: 'Please sign in again before deleting your account.' };
    const r = await fetch('/api/delete-account', { method: 'POST', headers: { Authorization: 'Bearer ' + session.access_token } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { error: data.error || 'Account deletion failed.' };
    await this.sb.auth.signOut();
    return { ok: true };
  },
  async getProStatus() {
    if (!this.isCloud()) return null;
    const { data: { session } } = await this.sb.auth.getSession();
    if (!session?.access_token) return null;
    const r = await fetch('/api/pro-status', { headers: { Authorization: 'Bearer ' + session.access_token } });
    const data = await r.json().catch(() => ({}));
    return r.ok ? data.entitlement || null : null;
  },


  async signOut() { if(this.isCloud()){this.unsubscribeSocial();if(this.collabChatChannel){this.sb.removeChannel(this.collabChatChannel);this.collabChatChannel=null;}await this.sb.auth.signOut();} },

  async getProfile(uid) {
    if (!this.isCloud() || !uid) return null;
    const { data } = await this.sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    return data;
  },

  /** Boolean wrapper kept for compatibility: true when every valid project was uploaded. */
  async saveProjects(userId, songs) {
    const r = await this.saveProjectsDetailed(userId, songs);
    return !!r.ok;
  },

  /**
   * Validates, then upserts projects in small chunks.
   * Resolves { ok, uploaded, rejected[], retryable, auth, error, reason }; it never throws.
   * `rejected` lists projects that failed validation and were NOT uploaded (they stay in local storage).
   */
  async saveProjectsDetailed(userId, songs) {
    const fail = (error, extra) => Object.assign({ ok: false, uploaded: 0, rejected: [], retryable: false, auth: false, error, reason: error }, extra || {});
    if (!this.isCloud() || !userId) return fail('not signed in to cloud');
    const Sync = window.AuralithProjectSync;
    let list = songs || [], rejected = [];
    if (Sync) {
      const prep = Sync.prepareProjects(list);
      list = prep.valid; rejected = prep.rejected;
      if (rejected.length) console.warn('saveProjects: skipped invalid projects', rejected);
    } else {
      console.warn('saveProjects: project-sync module not loaded; uploading without validation');
    }
    // Never upload under an id that is not the signed-in session (e.g. a save that outlived a sign-out/sign-in).
    const authUser = await this.currentAuthUser();
    if (!authUser) return fail('no active session', { rejected, auth: true });
    if (authUser.id !== userId) return fail('session belongs to a different user', { rejected, auth: true });

    let rows;
    try {
      rows = list.map(s => ({
        id: s.id,
        user_id: userId,
        title: s.title || 'Untitled',
        lyrics: s.lyrics || '',
        hook: s.hook || '',
        song_key: s.key || '',
        mood: s.mood || '',
        reference: s.ref || '',
        sections: s.sections || [],
        bpm: s.bpm || 120,
        step_count: s.stepCount || 16,
        pattern: s.pattern || {},
        kit: s.kit || 'trap',
        vocal_meta: s.vocalMeta || null,
        updated_at: new Date(s.updated || Date.now()).toISOString()
      }));
    } catch (e) {
      return fail('could not prepare projects: ' + (e && e.message), { rejected });
    }
    if (!rows.length) return { ok: true, uploaded: 0, rejected, retryable: false, auth: false };

    const CHUNK = 25;   // a bad row then only blocks its chunk, and requests stay small
    let uploaded = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      let error = null;
      try {
        const res = await this.sb.from('projects').upsert(rows.slice(i, i + CHUNK));
        error = res && res.error;
      } catch (e) { error = e || { message: 'upload failed' }; }
      if (error) {
        console.warn('saveProjects', error);
        const c = Sync ? Sync.classifyError(error) : { retryable: false, auth: false, reason: error.message };
        return { ok: false, uploaded, rejected, retryable: c.retryable, auth: c.auth, error: error.message || String(error), reason: c.reason };
      }
      uploaded += Math.min(CHUNK, rows.length - i);
    }
    return { ok: true, uploaded, rejected, retryable: false, auth: false };
  },

  /**
   * Deletes the given project ids belonging to userId. Only ever touches this user's rows (also enforced by RLS).
   * Resolves { ok, deleted, retryable, auth, error, reason }; never throws. Deleting a row that is already gone is success.
   */
  async deleteProjectsDetailed(userId, ids) {
    const fail = (error, extra) => Object.assign({ ok: false, deleted: 0, retryable: false, auth: false, error, reason: error }, extra || {});
    if (!this.isCloud() || !userId) return fail('not signed in to cloud');
    const clean = Array.from(new Set((Array.isArray(ids) ? ids : []).filter(x => x != null && String(x).trim() !== '').map(String)));
    if (!clean.length) return { ok: true, deleted: 0, retryable: false, auth: false };
    const authUser = await this.currentAuthUser();
    if (!authUser) return fail('no active session', { auth: true });
    if (authUser.id !== userId) return fail('session belongs to a different user', { auth: true });
    const Sync = window.AuralithProjectSync;
    const CHUNK = 100;
    let deleted = 0;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const chunk = clean.slice(i, i + CHUNK);
      let error = null;
      try {
        const res = await this.sb.from('projects').delete().eq('user_id', userId).in('id', chunk);
        error = res && res.error;
      } catch (e) { error = e || { message: 'delete failed' }; }
      if (error) {
        console.warn('deleteProjects', error);
        const c = Sync ? Sync.classifyError(error) : { retryable: false, auth: false, reason: error.message };
        return { ok: false, deleted, retryable: c.retryable, auth: c.auth, error: error.message || String(error), reason: c.reason };
      }
      deleted += chunk.length;
    }
    return { ok: true, deleted, retryable: false, auth: false };
  },

  async loadProjects(userId) {
    if (!this.isCloud() || !userId) return null;
    const { data, error } = await this.sb.from('projects').select('*').eq('user_id', userId).order('updated_at', { ascending: false });
    if (error) return null;
    return (data || []).map(r => ({
      id: r.id,
      title: r.title,
      lyrics: r.lyrics || '',
      hook: r.hook || '',
      key: r.song_key || '',
      mood: r.mood || '',
      ref: r.reference || '',
      sections: Array.isArray(r.sections) ? r.sections : [],
      bpm: r.bpm || 120,
      stepCount: r.step_count || 16,
      pattern: r.pattern || {},
      kit: r.kit || 'trap',
      vocalMeta: r.vocal_meta || null,
      updated: new Date(r.updated_at).getTime()
    }));
  },

  async publishFeed(post) {
    if(!this.isCloud())return false; const user=await this.currentAuthUser(); if(!user)return false;
    const row={id:post.id,user_id:user.id,username:post.username,avatar_url:post.avatar||null,title:post.title,caption:post.caption||'',lyrics:post.lyrics||'',hook:post.hook||'',bpm:post.bpm||120,kit:post.kit||'trap',pattern:post.pattern||null,step_count:post.stepCount||16,key_name:post.key||null,mood:post.mood||null,chords:post.chords||[],volumes:post.volumes||null,open_to_collab:!!post.openToCollab,has_vocal:!!post.hasVocal,has_sound:!!post.hasSound,full_song:!!post.fullSong,mixdown_url:post.mixdownUrl||null,created_at:new Date(post.updated||Date.now()).toISOString()};
    const {error}=await this.sb.from('feed_posts').upsert(row,{onConflict:'id'}); if(error){console.warn('publishFeed',error);return {ok:false,error:error.message||'Could not publish'};} return {ok:true};
  },
  async deleteFeedPost(postId) {
    if(!this.isCloud()||!postId)return {ok:false,error:'Cloud is not connected'};
    const user=await this.currentAuthUser(); if(!user)return {ok:false,error:'Not signed in'};
    try {
      // Delete dependent social rows first, then remove only a post owned by this user.
      await this.sb.from('likes').delete().eq('post_id',postId);
      await this.sb.from('comments').delete().eq('post_id',postId);
      const {error}=await this.sb.from('feed_posts').delete().eq('id',postId).eq('user_id',user.id);
      if(error) throw error;
      return {ok:true};
    } catch(e) {
      console.warn('deleteFeedPost',e);
      return {ok:false,error:e.message||'Could not delete post'};
    }
  },
  async fetchFeed(opts) {
    if(!this.isCloud())return null; let fq=this.sb.from('feed_posts').select('*'); if(opts&&opts.username)fq=fq.ilike('username',String(opts.username).replace(/[\\%_]/g,m=>'\\'+m)); const {data,error}=await fq.order('created_at',{ascending:false}).limit((opts&&opts.limit)||window.__thFeedLimit||30); if(error){console.warn('fetchFeed',error);return null;}
    const ids=(data||[]).map(p=>p.id); let likes=[],comments=[]; if(ids.length){const [l,c]=await Promise.all([this.sb.from('likes').select('post_id,user_id').in('post_id',ids),this.sb.from('comments').select('*').in('post_id',ids).order('created_at')]);likes=l.data||[];comments=c.data||[];}
    const posts=(data||[]).map(p=>({id:p.id,userId:p.user_id,username:p.username,avatar:p.avatar_url,title:p.title,caption:p.caption,lyrics:p.lyrics,hook:p.hook,bpm:p.bpm,kit:p.kit,pattern:p.pattern,stepCount:p.step_count,key:p.key_name,mood:p.mood,chords:p.chords||[],volumes:p.volumes,openToCollab:p.open_to_collab,hasVocal:p.has_vocal,hasSound:p.has_sound,fullSong:p.full_song,mixdownUrl:p.mixdown_url,updated:new Date(p.created_at).getTime()})); return {posts,likes,comments};
  },
  async setLike(postId,want) { if(!this.isCloud()||!postId)return false; const user=await this.currentAuthUser(); if(!user)return false; if(want){const {error}=await this.sb.from('likes').insert({post_id:postId,user_id:user.id}); return !error||error.code==='23505';} const {error}=await this.sb.from('likes').delete().eq('post_id',postId).eq('user_id',user.id); return !error; },
  async toggleLike(postId) { if(!this.isCloud()||!postId)return false; const user=await this.currentAuthUser(); if(!user)return false; const {data}=await this.sb.from('likes').select('*').eq('post_id',postId).eq('user_id',user.id).maybeSingle(); if(data){await this.sb.from('likes').delete().eq('post_id',postId).eq('user_id',user.id);return false;} const {error}=await this.sb.from('likes').insert({post_id:postId,user_id:user.id});return !error; },
  async addComment(postId,body,knownName) { if(!this.isCloud()||!postId)return null; const user=await this.currentAuthUser(); if(!user)return null; const uname=knownName||(await this.getProfile(user.id))?.username; const {data,error}=await this.sb.from('comments').insert({post_id:postId,user_id:user.id,username:uname||'Artist',body:String(body).slice(0,160)}).select('*').single(); if(error){console.warn('addComment',error);return null;}return data; },
  async getPublicProfile(usernameOrId) {
    if(!this.isCloud()||!usernameOrId)return null;
    // Never request private profile columns (contact, billing/pro status) for public artist pages.
    let q=this.sb.from('public_profiles').select('id,username,avatar_url,bio,location,genres,links,open_to_collab');
    q=/^[0-9a-f-]{36}$/i.test(String(usernameOrId))?q.eq('id',usernameOrId):q.ilike('username',String(usernameOrId));
    const {data}=await q.maybeSingle();
    return data||null;
  },
  async getProfileStats(userId) {
    if(!this.isCloud()||!userId)return {followers:0,following:0,published:0,likes:0};
    const [follower,following,published]=await Promise.all([
      this.sb.from('follows').select('*',{count:'exact',head:true}).eq('following_id',userId),
      this.sb.from('follows').select('*',{count:'exact',head:true}).eq('follower_id',userId),
      this.sb.from('feed_posts').select('*',{count:'exact',head:true}).eq('user_id',userId)
    ]);
    let likes=0;
    const {data:posts}=await this.sb.from('feed_posts').select('id').eq('user_id',userId).limit(80);
    if(posts?.length){const r=await this.sb.from('likes').select('*',{count:'exact',head:true}).in('post_id',posts.map(x=>x.id)); likes=r.count||0;}
    return {followers:follower.count||0,following:following.count||0,published:published.count||0,likes};
  },
  async blockUser(targetId) {
    if(!this.isCloud()||!targetId)return {error:'Not available'};
    const user=await this.currentAuthUser(); if(!user)return {error:'Sign in required'};
    const {error}=await this.sb.from('blocks').upsert({blocker_id:user.id,blocked_id:targetId},{onConflict:'blocker_id,blocked_id'});
    return error?{error:error.message}:{ok:true};
  },
  async unblockUser(targetId) {
    if(!this.isCloud()||!targetId)return {error:'Not available'};
    const user=await this.currentAuthUser(); if(!user)return {error:'Sign in required'};
    const {error}=await this.sb.from('blocks').delete().eq('blocker_id',user.id).eq('blocked_id',targetId);
    return error?{error:error.message}:{ok:true};
  },
  async reportUser(targetId, reason) {
    if(!this.isCloud()||!targetId)return {error:'Not available'};
    const user=await this.currentAuthUser(); if(!user)return {error:'Sign in required'};
    const {error}=await this.sb.from('reports').insert({reporter_id:user.id,reported_user_id:targetId,reason:String(reason||'other').slice(0,80)});
    return error?{error:error.message}:{ok:true};
  },

  subscribeSocial(onChange) { if(!this.isCloud())return()=>{}; this.unsubscribeSocial(); this.feedChannel=this.sb.channel('social-feed').on('postgres_changes',{event:'*',schema:'public',table:'feed_posts'},onChange).on('postgres_changes',{event:'*',schema:'public',table:'likes'},onChange).on('postgres_changes',{event:'*',schema:'public',table:'comments'},onChange).subscribe(); this.messageChannel=this.sb.channel('social-messages').on('postgres_changes',{event:'*',schema:'public',table:'messages'},onChange).subscribe(); this.followChannel=this.sb.channel('social-follows').on('postgres_changes',{event:'*',schema:'public',table:'follows'},onChange).subscribe(); return ()=>this.unsubscribeSocial(); },
  unsubscribeSocial() { if(!this.sb)return; ['feedChannel','messageChannel','followChannel'].forEach(k=>{if(this[k]){this.sb.removeChannel(this[k]);this[k]=null;}}); },
  async fetchCollabMessages(roomCode) { if(!this.isCloud()||!roomCode)return []; const {data,error}=await this.sb.from('collab_messages').select('*').eq('room_code',roomCode).order('created_at',{ascending:true}).limit(100);if(error){console.warn('fetchCollabMessages',error);return [];}return data||[]; },
  async sendCollabMessage(roomCode,body) { if(!this.isCloud()||!roomCode||!body)return null; const user=await this.currentAuthUser();if(!user)return null;const profile=await this.getProfile(user.id);const {data,error}=await this.sb.from('collab_messages').insert({room_code:roomCode,user_id:user.id,username:profile?.username||'Artist',body:String(body).slice(0,500)}).select('*').single();if(error){console.warn('sendCollabMessage',error);return null;}return data; },
  subscribeCollabChat(code,onChange) { if(!this.isCloud()||!code)return()=>{};if(this.collabChatChannel)this.sb.removeChannel(this.collabChatChannel);this.collabChatChannel=this.sb.channel('collab-chat:'+code).on('postgres_changes',{event:'*',schema:'public',table:'collab_messages',filter:`room_code=eq.${code}`},onChange).subscribe();return()=>{if(this.collabChatChannel){this.sb.removeChannel(this.collabChatChannel);this.collabChatChannel=null;}}; },
  async createRoom(room) {
    if (!this.isCloud()) return false;
    const { error } = await this.sb.from('rooms').insert({
      code: room.code,
      host_id: room.hostId,
      title: room.title,
      bpm: room.bpm,
      kit: room.kit,
      pattern: room.pattern,
      sections: room.sections,
      updated_at: new Date().toISOString()
    });
    if (error) { console.warn(error); return false; }
    const { error: joinError } = await this.sb.rpc('join_room_limited', { p_room_code: room.code });
    if (joinError) {
      console.warn(joinError);
      await this.sb.from('rooms').delete().eq('code', room.code);
      return false;
    }
    return true;
  },

  async joinRoom(code, user) {
    if (!this.isCloud()) return null;
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return null;
    const { data: joined, error: joinError } = await this.sb.rpc('join_room_limited', { p_room_code: normalized });
    if (joinError || !joined) { if (joinError) console.warn(joinError); return null; }
    const { data: room, error } = await this.sb.from('rooms').select('*').eq('code', normalized).maybeSingle();
    if (error || !room) return null;
    const { data: members } = await this.sb.from('room_members').select('*').eq('room_code', normalized);
    const { data: vocals } = await this.sb.from('room_vocals').select('*').eq('room_code', normalized);
    const safeVocals = await this._signRoomVocals(vocals || []);
    return this._mapRoom(room, members, safeVocals);
  },

  async getRoom(code) {
    if (!this.isCloud()) return null;
    const { data: room } = await this.sb.from('rooms').select('*').eq('code', code).maybeSingle();
    if (!room) return null;
    const { data: members } = await this.sb.from('room_members').select('*').eq('room_code', code);
    const { data: vocals } = await this.sb.from('room_vocals').select('*').eq('room_code', code);
    const safeVocals = await this._signRoomVocals(vocals || []);
    return this._mapRoom(room, members, safeVocals);
  },

  async _signRoomVocals(vocals) {
    if (!this.isCloud()) return vocals || [];
    return Promise.all((vocals || []).map(async v => {
      if (!v.file_path) return v;
      try {
        const { data } = await this.sb.storage.from('vocals').createSignedUrl(v.file_path, 60 * 60);
        return { ...v, file_url: data?.signedUrl || null };
      } catch (e) { return { ...v, file_url: null }; }
    }));
  },

  async saveRoom(room) {
    if (!this.isCloud()) return false;
    // Rooms are created once by createRoom(); afterwards any member may edit content.
    // Use a plain UPDATE so row-level security can keep host_id/code immutable
    // and so non-host members are not rejected by the INSERT policy.
    const row = {
      title: room.title,
      bpm: room.bpm,
      kit: room.kit,
      pattern: room.pattern,
      sections: room.sections,
      updated_at: new Date().toISOString()
    };
    // continuity column is optional until supabase-continuity.sql is applied
    if (room.continuity) row.continuity = room.continuity;
    // Skip the write when nothing but the timestamp changed: every UPDATE fans out as a realtime event to
    // all members, so redundant saves cost bandwidth/battery for everyone in the room.
    const sig = JSON.stringify([row.title, row.bpm, row.kit, row.pattern, row.sections, row.continuity || null]);
    this._roomSaved = this._roomSaved || {};
    if (this._roomSaved[room.code] === sig) return true;
    let { error } = await this.sb.from('rooms').update(row).eq('code', room.code);
    if (error && room.continuity && /continuity|column/i.test(String(error.message || error))) {
      delete row.continuity;
      ({ error } = await this.sb.from('rooms').update(row).eq('code', room.code));
    }
    if (error) console.warn('[Auralith] saveRoom', error);
    else this._roomSaved[room.code] = sig;
    return !error;
  },

  async uploadVocal(roomCode, user, file) {
    if (!this.isCloud()) return null;
    const authUser = await this.currentAuthUser();
    if (!authUser?.id || !user?.id || authUser.id !== user.id) {
      (window.toast||function(){})('Sign in with the account you want to upload from');
      return null;
    }
    const normalizedRoomCode = String(roomCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,64}$/.test(normalizedRoomCode)) {
      (window.toast||function(){})('Invalid collaboration room');
      return null;
    }
    if (!file || !file.size) { (window.toast||function(){})('Choose an audio file first'); return null; }
    const allowed = ['audio/webm','audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/ogg','audio/aac'];
    if (file.type && !allowed.includes(file.type.toLowerCase())) { (window.toast||function(){})('Unsupported audio format'); return null; }
    if (file.size > 25 * 1024 * 1024) { (window.toast||function(){})('Audio files must be 25MB or smaller'); return null; }
    const safeName = String(file.name || 'vocal').replace(/[^\w.\-]/g, '_').replace(/\.{2,}/g, '.').slice(-120) || 'vocal';
    const path = `${authUser.id}/${normalizedRoomCode}_${Date.now()}_${safeName}`;
    const { error } = await this.sb.storage.from('vocals').upload(path, file, { upsert: false });
    if (error) { console.warn('[Auralith] vocal upload failed', error); return null; }
    const { data: signed, error: signedError } = await this.sb.storage.from('vocals').createSignedUrl(path, 60 * 60);
    if (signedError || !signed?.signedUrl) {
      const cleanup = await this.sb.storage.from('vocals').remove([path]);
      if (cleanup.error) console.error('[Auralith] orphan vocal cleanup failed', cleanup.error);
      return null;
    }
    const fileUrl = signed.signedUrl;
    // Remember this artist's previous vocal(s) in the room: their audio must be removed once the replacement
    // is safely saved, and their metadata restored if the replacement fails (never lose an existing vocal).
    const { data: prevRows } = await this.sb.from('room_vocals').select('*').eq('room_code', normalizedRoomCode).eq('user_id', authUser.id);
    const previous = Array.isArray(prevRows) ? prevRows : [];
    const { error: deleteError } = await this.sb.from('room_vocals').delete().eq('room_code', normalizedRoomCode).eq('user_id', authUser.id);
    if (deleteError) {
      const cleanup = await this.sb.storage.from('vocals').remove([path]);
      if (cleanup.error) console.error('[Auralith] orphan vocal cleanup failed', cleanup.error);
      console.warn('[Auralith] previous vocal metadata could not be replaced', deleteError);
      return null;
    }
    const { error: metaError } = await this.sb.from('room_vocals').insert({
      room_code: normalizedRoomCode,
      user_id: authUser.id,
      username: String(user.username || 'Artist').slice(0, 80),
      file_path: path,
      file_url: fileUrl
    });
    if (metaError) {
      const cleanup = await this.sb.storage.from('vocals').remove([path]);
      if (cleanup.error) console.error('[Auralith] orphan vocal cleanup failed', cleanup.error);
      console.warn('[Auralith] vocal metadata save failed', metaError);
      if (previous.length) {
        const restore = previous.map(({ id, created_at, ...rest }) => rest);
        const restored = await this.sb.from('room_vocals').insert(restore);
        if (restored.error) console.error('[Auralith] could not restore previous vocal metadata', restored.error);
      }
      return null;
    }
    // The replacement is saved: delete the superseded audio (own folder only) so old private recordings do not linger.
    const stale = previous.map(r => r && r.file_path).filter(p => typeof p === 'string' && p !== path && p.startsWith(authUser.id + '/') && !p.includes('..'));
    if (stale.length) {
      const removed = await this.sb.storage.from('vocals').remove(stale);
      if (removed.error) console.error('[Auralith] superseded vocal cleanup failed', removed.error);
    }
    return fileUrl;
  },

  subscribeRoom(code, onChange) {
    if (!this.isCloud()) return () => {};
    this.unsubscribeRoom();
    this.roomChannel = this.sb.channel('room:' + code)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `code=eq.${code}` }, () => { if (this._roomSaved) delete this._roomSaved[code]; onChange(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: `room_code=eq.${code}` }, () => onChange())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_vocals', filter: `room_code=eq.${code}` }, () => onChange())
      .subscribe();
    return () => this.unsubscribeRoom();
  },

  /** Remove the signed-in user's membership so they lose access to the room (and its private audio). */
  async leaveRoom(roomCode) {
    if (!this.isCloud()) return true;
    const code = String(roomCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,64}$/.test(code)) return false;
    const authUser = await this.currentAuthUser();
    if (!authUser?.id) return false;
    const { error } = await this.sb.from('room_members').delete().eq('room_code', code).eq('user_id', authUser.id);
    if (error) { console.warn('[Auralith] leaveRoom', error); return false; }
    return true;
  },

  unsubscribeRoom() {
    if (this.roomChannel && this.sb) {
      this.sb.removeChannel(this.roomChannel);
      this.roomChannel = null;
    }
  },

  _mapRoom(room, members, vocals) {
    return {
      code: room.code,
      hostId: room.host_id,
      hostName: members?.find(m => m.user_id === room.host_id)?.username || 'Host',
      title: room.title,
      bpm: room.bpm,
      kit: room.kit,
      pattern: room.pattern,
      sections: room.sections || [],
      members: (members || []).map(m => ({
        id: m.user_id,
        username: m.username,
        avatar: m.avatar_url
      })),
      vocals: (vocals || []).map(v => ({
        userId: v.user_id,
        username: v.username,
        name: 'Vocal',
        dataUrl: v.file_url,
        at: new Date(v.created_at).getTime()
      })),
      updated: new Date(room.updated_at).getTime()
    };
  }
};


})();
