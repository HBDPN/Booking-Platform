import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || ''
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null

// camelCase ↔ snake_case conversion
const toSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const keysToSnake = (obj) => {
  if (Array.isArray(obj)) return obj.map(keysToSnake)
  if (obj && typeof obj === 'object' && !(obj instanceof Date)) {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [toSnake(k), v]))
  }
  return obj
}
const keysToCamel = (obj) => {
  if (Array.isArray(obj)) return obj.map(keysToCamel)
  if (obj && typeof obj === 'object' && !(obj instanceof Date)) {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [toCamel(k), v]))
  }
  return obj
}

// Fallback to localStorage when Supabase is not configured
const localStore = {
  async get(k) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null } catch { return null }
  },
  async set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)) } catch {}
  },
  async list(prefix) {
    const keys = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k.startsWith(prefix)) keys.push(k)
    }
    return keys
  },
  async del(k) {
    try { localStorage.removeItem(k) } catch {}
  }
}

// Storage abstraction - uses Supabase when available, localStorage as fallback
export const S = {
  // ── Salons ──
  async getSalon(id) {
    if (supabase) {
      const { data } = await supabase.from('salons').select('*').eq('id', id).single()
      if (!data) return null
      // Hydrate related data
      const [staff, services, bookings, clients, reviews, waitlist, notifications, templates, ooh, holidays, msgLog, campaigns] = await Promise.all([
        supabase.from('staff').select('*').eq('salon_id', id),
        supabase.from('services').select('*').eq('salon_id', id),
        supabase.from('bookings').select('*').eq('salon_id', id),
        supabase.from('clients').select('*').eq('salon_id', id),
        supabase.from('reviews').select('*').eq('salon_id', id),
        supabase.from('waitlist').select('*').eq('salon_id', id),
        supabase.from('notifications').select('*').eq('salon_id', id).order('created_at', { ascending: false }).limit(100),
        supabase.from('notification_templates').select('*').eq('salon_id', id),
        supabase.from('ooh_requests').select('*').eq('salon_id', id),
        supabase.from('staff_holidays').select('*').eq('salon_id', id),
        supabase.from('message_log').select('*').eq('salon_id', id),
        supabase.from('campaigns').select('*').eq('salon_id', id),
      ])
      return keysToCamel({
        ...data,
        staff: (staff.data || []).map(keysToCamel),
        services: (services.data || []).map(keysToCamel),
        bookings: (bookings.data || []).map(keysToCamel),
        clients: (clients.data || []).map(keysToCamel),
        reviews: (reviews.data || []).map(keysToCamel),
        waitlist: (waitlist.data || []).map(keysToCamel),
        notifications: (notifications.data || []).map(keysToCamel),
        notificationTemplates: (templates.data || []).map(keysToCamel),
        oohRequests: (ooh.data || []).map(keysToCamel),
        staffHolidays: (holidays.data || []).map(keysToCamel),
        messageLog: (msgLog.data || []).map(keysToCamel),
        campaigns: (campaigns.data || []).map(keysToCamel),
      })
    }
    return localStore.get('salon:' + id)
  },

  async listSalons() {
    if (supabase) {
      try {
        const { data } = await supabase.from('salons').select('*')
        if (data && data.length > 0) {
          const result = {}
          for (const s of data) {
            result[s.id] = await S.getSalon(s.id)
          }
          return result
        }
      } catch (e) {
        console.warn('Supabase read failed, falling back to localStorage:', e.message)
      }
    }
    // Fallback to localStorage
    const keys = await localStore.list('salon:')
    const result = {}
    for (const k of keys) {
      const d = await localStore.get(k)
      if (d) result[d.id] = d
    }
    return result
  },

  async saveSalon(salon) {
    await localStore.set('salon:' + salon.id, salon)
    if (supabase) {
      try {
        const { staff, services, bookings, clients, reviews, waitlist, notifications, notificationTemplates, oohRequests, staffHolidays, messageLog, campaigns, ...salonData } = salon
        await supabase.from('salons').upsert(keysToSnake(salonData))
      } catch (e) {
        console.warn('Supabase save failed:', e.message)
      }
    }
  },

  // ── Table-level operations for Supabase ──
  async upsertRow(table, row) {
    if (supabase) {
      const { data, error } = await supabase.from(table).upsert(row).select().single()
      return data
    }
    return null
  },

  async insertRow(table, row) {
    if (supabase) {
      const { data, error } = await supabase.from(table).insert(row).select().single()
      return data
    }
    return null
  },

  async deleteRow(table, id) {
    if (supabase) {
      await supabase.from(table).delete().eq('id', id)
    }
  },

  async updateRow(table, id, updates) {
    if (supabase) {
      const { data } = await supabase.from(table).update(updates).eq('id', id).select().single()
      return data
    }
    return null
  },

  async queryRows(table, filters = {}) {
    if (supabase) {
      let q = supabase.from(table).select('*')
      for (const [k, v] of Object.entries(filters)) q = q.eq(k, v)
      const { data } = await q
      return data || []
    }
    return []
  },

  // ── Auth helpers ──
  async getAccount(key) {
    if (supabase) return null // handled by Supabase Auth
    return localStore.get(key)
  },
  async setAccount(key, val) {
    if (supabase) return // handled by Supabase Auth
    return localStore.set(key, val)
  },
  async getSession(key) {
    if (supabase) return null
    return localStore.get(key)
  },
  async setSession(key, val) {
    if (supabase) return
    return localStore.set(key, val)
  },
  async delSession(key) {
    if (supabase) return
    return localStore.del(key)
  },

  // ── Full save - saves to localStorage always, and to Supabase when available ──
  async saveFullSalon(salon) {
    // Always save to localStorage as reliable cache
    await localStore.set('salon:' + salon.id, salon)
    if (supabase) {
      try {
        const { staff = [], services = [], bookings = [], clients = [], reviews = [], waitlist = [], notifications = [], notificationTemplates = [], oohRequests = [], staffHolidays = [], messageLog = [], campaigns = [], ...salonData } = salon
        await supabase.from('salons').upsert(keysToSnake(salonData))
        const syncTable = async (table, rows) => {
          if (!rows.length) return
          const snakeRows = rows.map(r => ({ ...keysToSnake(r), salon_id: salon.id }))
          await supabase.from(table).upsert(snakeRows, { onConflict: table === 'staff' || table === 'services' || table === 'clients' ? 'id,salon_id' : 'id' })
        }
        await Promise.all([
          syncTable('staff', staff),
          syncTable('services', services),
          syncTable('bookings', bookings),
          syncTable('clients', clients),
          syncTable('reviews', reviews),
          syncTable('waitlist', waitlist),
          syncTable('notifications', notifications),
          syncTable('notification_templates', notificationTemplates),
          syncTable('ooh_requests', oohRequests),
          syncTable('staff_holidays', staffHolidays),
          syncTable('message_log', messageLog),
          syncTable('campaigns', campaigns),
        ])
      } catch (e) {
        console.warn('Supabase save failed, data saved to localStorage:', e.message)
      }
    }
  },

  // ── Super Admin queries ──
  async getAllUsers() {
    if (supabase) {
      // This requires service_role key or admin API - for now return from auth
      const { data } = await supabase.auth.admin.listUsers()
      return data?.users || []
    }
    return []
  },

  async getAllBookingsCount() {
    if (supabase) {
      const { count } = await supabase.from('bookings').select('*', { count: 'exact', head: true })
      return count || 0
    }
    return 0
  }
}

// ── Auth Layer ──
export const Auth = {
  async signUp(email, password, metadata = {}) {
    if (supabase) {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: metadata }
      })
      if (error) throw error
      return data
    }
    // localStorage fallback
    return { user: { email, user_metadata: metadata } }
  },

  async signIn(email, password) {
    if (supabase) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      return data
    }
    return { user: { email } }
  },

  async signOut() {
    if (supabase) {
      await supabase.auth.signOut()
    }
  },

  async getUser() {
    if (supabase) {
      const { data } = await supabase.auth.getUser()
      return data?.user || null
    }
    return null
  },

  async getSession() {
    if (supabase) {
      const { data } = await supabase.auth.getSession()
      return data?.session || null
    }
    return null
  },

  onAuthStateChange(callback) {
    if (supabase) {
      return supabase.auth.onAuthStateChange(callback)
    }
    return { data: { subscription: { unsubscribe: () => {} } } }
  }
}
