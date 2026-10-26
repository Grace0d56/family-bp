/* No npm, no CDN, no secret keys: calls Supabase Auth and PostgREST directly. */
(function () {
  'use strict';

  const DEMO_KEY = 'family-bp-demo-v1';
  const today = (delta = 0) => {
    const d = new Date(); d.setDate(d.getDate() + delta);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const uid = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    // Secure-context restriction: randomUUID may be unavailable on an HTTP LAN test.
    // getRandomValues works on most non-HTTPS contexts and still creates a valid UUID.
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random()*256);
    bytes[6] = (bytes[6]&15)|64; bytes[8] = (bytes[8]&63)|128;
    const h = [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  };

  class RequestError extends Error {
    constructor(message, kind = 'api', status = 0) {
      super(message); this.name = 'RequestError'; this.kind = kind; this.status = status;
    }
  }

  class DemoBackend {
    constructor() { this.mode = 'demo'; this.session = {user: {id: 'demo-home'}}; this.ensureDemo(); }
    ensureDemo() {
      if (localStorage.getItem(DEMO_KEY)) return;
      const members = [
        {id:'demo-dad',name:'爸爸',takes_medicine:true,created_at:'2026-01-01T00:00:00Z'},
        {id:'demo-mom',name:'妈妈',takes_medicine:false,created_at:'2026-01-01T00:00:00Z'}
      ];
      const raws = [
        ['demo-dad',-12,'08:10',135,86,75,'before'],
        ['demo-dad',-9,'08:20',131,84,74,'before'],
        ['demo-dad',-6,'07:45',132,85,76,'before'],
        ['demo-dad',-4,'08:10',129,83,73,'before'],
        ['demo-dad',-2,'20:15',126,81,72,'after'],
        ['demo-dad',0,'08:00',128,82,72,'before'],
        ['demo-mom',-10,'08:00',116,77,70,'no'],
        ['demo-mom',-5,'08:00',119,78,70,'no'],
        ['demo-mom',-3,'19:30',123,80,73,'no'],
        ['demo-mom',-1,'08:15',120,79,71,'no']
      ];
      const measurements = raws.map(([member_id,day,measured_time,systolic,diastolic,pulse,medication_status],i) => ({
        id:`demo-measure-${i}`,member_id,measured_on:today(day),measured_time,systolic,diastolic,pulse,
        medication_status,note:'',created_at:new Date().toISOString()
      }));
      localStorage.setItem(DEMO_KEY, JSON.stringify({members,measurements,checks:[]}));
    }
    read() { return JSON.parse(localStorage.getItem(DEMO_KEY)); }
    write(d) { localStorage.setItem(DEMO_KEY, JSON.stringify(d)); }
    get user() { return this.session.user; }
    async listMembers() { return this.read().members; }
    async addMember(member) {
      const d=this.read();const saved={id:uid(),...member,created_at:new Date().toISOString()};
      d.members.push(saved);this.write(d);return saved;
    }
    async updateMember(id,patch) {
      const d=this.read();const i=d.members.findIndex(m=>m.id===id);
      if(i<0) throw new RequestError('找不到这个家人');
      d.members[i]={...d.members[i],...patch};this.write(d);return d.members[i];
    }
    async listMeasurements(memberId) {
      return this.read().measurements.filter(r=>r.member_id===memberId).sort((a,b)=>
        `${b.measured_on}T${b.measured_time}${b.created_at}`.localeCompare(`${a.measured_on}T${a.measured_time}${a.created_at}`));
    }
    async saveMeasurement(rec) {
      const d=this.read();const i=d.measurements.findIndex(r=>r.id===rec.id);
      const saved={...rec,created_at:i<0?new Date().toISOString():d.measurements[i].created_at};
      if(i<0) d.measurements.push(saved);else d.measurements[i]=saved;
      this.write(d);return saved;
    }
    async deleteMeasurement(id) {const d=this.read();d.measurements=d.measurements.filter(r=>r.id!==id);this.write(d);}
    async writeCheck(code) {const d=this.read();const c={id:uid(),code,created_at:new Date().toISOString()};d.checks.push(c);this.write(d);return c;}
    async readLatestCheck() {return this.read().checks.slice().sort((a,b)=>b.created_at.localeCompare(a.created_at))[0]||null;}
    async signOut() {}
  }

  class SupabaseBackend {
    constructor(url, publishableKey) {
      this.url = url.replace(/\/+$/,''); this.key = publishableKey.trim(); this.mode = 'cloud';
      this.sessionKey = `family-bp-session:${this.url}`;
      this.session = this.loadSession(); this.refreshing = null;
    }
    loadSession() {
      try { const j=localStorage.getItem(this.sessionKey); return j?JSON.parse(j):null; }
      catch {return null;}
    }
    setSession(body) {
      if (!body?.access_token || !body?.refresh_token) throw new RequestError('登录信息不完整，请重新登录','auth');
      this.session = {access_token:body.access_token,refresh_token:body.refresh_token,
        expires_at:Date.now()+(Math.max(Number(body.expires_in)||3600,60)*1000),user:body.user};
      localStorage.setItem(this.sessionKey,JSON.stringify(this.session));
    }
    get user() {return this.session?.user || null;}
    clearSession() {this.session=null;localStorage.removeItem(this.sessionKey);}
    async rawFetch(path,{method='GET', body=null, authorized=false, prefer=null, timeout=14000,headers={}}={}) {
      const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),timeout);
      try {
        // Publishable keys are NOT JWTs. Send only apikey until a user signs in.
        const outgoing={'apikey':this.key,...headers};
        if(body!==null) outgoing['Content-Type']='application/json';
        if(prefer) outgoing['Prefer']=prefer;
        if(authorized) outgoing.Authorization=`Bearer ${await this.getToken()}`;
        const res=await fetch(`${this.url}${path}`,{method,headers:outgoing,body:body===null?undefined:JSON.stringify(body),signal:ctrl.signal});
        const raw=await res.text(); let result;
        try {result=raw?JSON.parse(raw):null;} catch {result=raw;}
        if(!res.ok) {
          const detail=typeof result==='object' && result ? (result.msg||result.message||result.error_description||result.error||result.hint) : '';
          const kind=res.status===401||res.status===403?'auth':'api';
          throw new RequestError(detail||`服务器返回 ${res.status}`,kind,res.status);
        }
        return result;
      } catch(e) {
        if(e.name==='AbortError')throw new RequestError('连接超时；请检查网络后重试','network');
        if(e instanceof TypeError)throw new RequestError('网络无法连接 Supabase；请检查网络后重试','network');
        throw e;
      } finally {clearTimeout(timer);}
    }
    async signup(email,password) {
      const response=await this.rawFetch('/auth/v1/signup',{method:'POST',body:{email,password}});
      if(response?.access_token&&response?.refresh_token){this.setSession(response);return {loggedIn:true};}
      return {loggedIn:false}; // Supabase may require clicking the verification email.
    }
    async signIn(email,password) {
      const response=await this.rawFetch('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});
      this.setSession(response);
    }
    async refresh() {
      if (!this.session?.refresh_token) throw new RequestError('请重新登录家庭账号','auth');
      if(this.refreshing)return this.refreshing;
      this.refreshing=(async()=>{
        try {
          const response=await this.rawFetch('/auth/v1/token?grant_type=refresh_token',{
            method:'POST',body:{refresh_token:this.session.refresh_token}
          });this.setSession(response);return this.session.access_token;
        }catch(e){if(e.kind==='auth'){this.clearSession();}throw e;}
        finally{this.refreshing=null;}
      })();
      return this.refreshing;
    }
    async getToken() {
      if(!this.session)throw new RequestError('请先登录家庭账号','auth');
      if(!this.session.expires_at||Date.now()+60_000>=this.session.expires_at)await this.refresh();
      return this.session.access_token;
    }
    async rest(table,{method='GET',query='',body=null,prefer=null}={}) {
      const url=`/rest/v1/${table}${query?'?'+query:''}`;
      try {return await this.rawFetch(url,{method,body,prefer,authorized:true});}
      catch(e) {
        if(e.kind==='auth'&&this.session&&e.status===401){
          await this.refresh();return this.rawFetch(url,{method,body,prefer,authorized:true});
        }
        throw e;
      }
    }
    async listMembers() {
      return this.rest('bp_members',{query:'select=id,name,takes_medicine,created_at&order=created_at.asc'});
    }
    async addMember(member) {
      const rows=await this.rest('bp_members',{method:'POST',body:member,prefer:'return=representation'});
      return rows[0];
    }
    async updateMember(id,patch) {
      const rows=await this.rest('bp_members',{method:'PATCH',query:`id=eq.${encodeURIComponent(id)}`,body:patch,prefer:'return=representation'});
      if(!rows.length)throw new RequestError('未找到成员，或没有权限修改');return rows[0];
    }
    async listMeasurements(memberId) {
      // Paginate so the family does not hit PostgREST's normal 1000-row response limit.
      const all=[];let offset=0;const limit=500;
      for (;;) {
        const rows=await this.rest('bp_measurements',{query:
          `select=id,member_id,measured_on,measured_time,systolic,diastolic,pulse,medication_status,note,created_at&member_id=eq.${encodeURIComponent(memberId)}&order=measured_on.desc,measured_time.desc,created_at.desc&limit=${limit}&offset=${offset}`});
        all.push(...rows); if(rows.length<limit)break;offset+=limit;
        if(offset>50000)throw new RequestError('记录过多，请联系维护人员');
      }
      return all;
    }
    async saveMeasurement(rec) {
      // Idempotent upsert: if a request reaches the server but the reply is lost,
      // retrying cannot create a second copy of the same reading.
      const rows=await this.rest('bp_measurements',{method:'POST',query:'on_conflict=id',body:rec,
        prefer:'resolution=merge-duplicates,return=representation'});
      return rows[0];
    }
    async deleteMeasurement(id) {
      await this.rest('bp_measurements',{method:'DELETE',query:`id=eq.${encodeURIComponent(id)}`});
    }
    async writeCheck(code) {
      const rows=await this.rest('bp_sync_checks',{method:'POST',body:{code},prefer:'return=representation'});
      return rows[0];
    }
    async readLatestCheck() {
      const rows=await this.rest('bp_sync_checks',{query:'select=id,code,created_at&order=created_at.desc&limit=1'});
      return rows[0]||null;
    }
    async signOut() {
      // This device should forget the family login even if the network is down.
      this.clearSession();
    }
  }

  function validateConfig(url,key) {
    const u=url.trim().replace(/\/+$/,'');const k=key.trim();
    if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u))throw new RequestError('Project URL 格式应为 https://项目名.supabase.co');
    if(!k || k.startsWith('sb_secret_') || k.includes('service_role'))throw new RequestError('只能填写 Supabase Publishable Key，不能使用 Secret Key');
    return {url:u,key:k};
  }
  window.BPBackend={DemoBackend,SupabaseBackend,RequestError,validateConfig,uid,today};
})();
