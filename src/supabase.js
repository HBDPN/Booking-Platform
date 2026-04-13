import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || ''
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null

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
      return {
        ...data,
        staff: staff.data || [],
        services: services.data || [],
        bookings: bookings.data || [],
        clients: clients.data || [],
        reviews: reviews.data || [],
        waitlist: waitlist.data || [],
        notifications: notifications.data || [],
        notificationTemplates: templates.data || [],
        oohRequests: ooh.data || [],
        staffHolidays: holidays.data || [],
        messageLog: msgLog.data || [],
        campaigns: campaigns.data || [],
      }
    }
    return localStore.get('salon:' + id)
  },

  async listSalons() {
    if (supabase) {
      const { data } = await supabase.from('salons').select('*')
      if (!data) return {}
      const result = {}
      for (const s of data) {
        result[s.id] = await S.getSalon(s.id)
      }
      return result
    }
    const keys = await localStore.list('salon:')
    const result = {}
    for (const k of keys) {
      const d = await localStore.get(k)
      if (d) result[d.id] = d
    }
    return result
  },

  async saveSalon(salon) {
    if (supabase) {
      const { staff, services, bookings, clients, reviews, waitlist, notifications, notificationTemplates, oohRequests, staffHolidays, messageLog, campaigns, ...salonData } = salon
      await supabase.from('salons').upsert(salonData)
      return
    }
    return localStore.set('salon:' + salon.id, salon)
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

  // ── Full save (localStorage mode) - saves entire salon object ──
  async saveFullSalon(salon) {
    return localStore.set('salon:' + salon.id, salon)
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
