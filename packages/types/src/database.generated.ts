/**
 * Types generated from Carl's migrations.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with `pnpm db:types`.
 *
 * Produced by introspecting the real migrations applied to an in-process PostgreSQL, so it
 * needs no Docker and stays correct in CI. See scripts/generate-db-types.mjs.
 *
 * 55 relations, 28 enums, 60 functions.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      app_errors: {
        Row: {
          id: string;
          occurred_at: string;
          digest: string | null;
          message: string;
          route: string | null;
          method: string | null;
          surface: string | null;
          tenant_id: string | null;
          user_id: string | null;
        };
        Insert: {
          id?: string;
          occurred_at?: string;
          digest?: string | null;
          message: string;
          route?: string | null;
          method?: string | null;
          surface?: string | null;
          tenant_id?: string | null;
          user_id?: string | null;
        };
        Update: {
          id?: string;
          occurred_at?: string;
          digest?: string | null;
          message?: string;
          route?: string | null;
          method?: string | null;
          surface?: string | null;
          tenant_id?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'app_errors_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'app_errors_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      audit_logs: {
        Row: {
          id: string;
          tenant_id: string | null;
          branch_id: string | null;
          actor_id: string | null;
          actor_email: string | null;
          actor_name: string | null;
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          before_state: Json | null;
          after_state: Json | null;
          metadata: Json;
          device_id: string | null;
          ip_address: string | null;
          user_agent: string | null;
          request_id: string | null;
          occurred_at: string;
        };
        Insert: {
          id?: string;
          tenant_id?: string | null;
          branch_id?: string | null;
          actor_id?: string | null;
          actor_email?: string | null;
          actor_name?: string | null;
          action: string;
          entity_type?: string | null;
          entity_id?: string | null;
          before_state?: Json | null;
          after_state?: Json | null;
          metadata?: Json;
          device_id?: string | null;
          ip_address?: string | null;
          user_agent?: string | null;
          request_id?: string | null;
          occurred_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string | null;
          branch_id?: string | null;
          actor_id?: string | null;
          actor_email?: string | null;
          actor_name?: string | null;
          action?: string;
          entity_type?: string | null;
          entity_id?: string | null;
          before_state?: Json | null;
          after_state?: Json | null;
          metadata?: Json;
          device_id?: string | null;
          ip_address?: string | null;
          user_agent?: string | null;
          request_id?: string | null;
          occurred_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'audit_logs_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'audit_logs_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'audit_logs_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      branches: {
        Row: {
          id: string;
          tenant_id: string;
          code: string;
          name: string;
          address: string | null;
          phone: string | null;
          timezone: string | null;
          is_default: boolean;
          is_active: boolean;
          allow_negative_stock: boolean;
          opened_at: string | null;
          closed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          code: string;
          name: string;
          address?: string | null;
          phone?: string | null;
          timezone?: string | null;
          is_default?: boolean;
          is_active?: boolean;
          allow_negative_stock?: boolean;
          opened_at?: string | null;
          closed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          code?: string;
          name?: string;
          address?: string | null;
          phone?: string | null;
          timezone?: string | null;
          is_default?: boolean;
          is_active?: boolean;
          allow_negative_stock?: boolean;
          opened_at?: string | null;
          closed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'branches_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: true;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      cash_movements: {
        Row: {
          id: string;
          session_id: string;
          tenant_id: string;
          branch_id: string;
          movement_type: Database['public']['Enums']['cash_movement_type'];
          amount: number;
          reason: string;
          notes: string | null;
          performed_by: string;
          occurred_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          tenant_id: string;
          branch_id: string;
          movement_type: Database['public']['Enums']['cash_movement_type'];
          amount: number;
          reason: string;
          notes?: string | null;
          performed_by: string;
          occurred_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          session_id?: string;
          tenant_id?: string;
          branch_id?: string;
          movement_type?: Database['public']['Enums']['cash_movement_type'];
          amount?: number;
          reason?: string;
          notes?: string | null;
          performed_by?: string;
          occurred_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'cash_movements_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_movements_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'cash_sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_movements_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      cash_registers: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          name: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          name: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          name?: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'cash_registers_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_registers_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      cash_sessions: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          register_id: string;
          device_id: string | null;
          status: Database['public']['Enums']['cash_session_status'];
          opening_float: number;
          cash_sales: number;
          cash_refunds: number;
          cash_in: number;
          cash_out: number;
          cash_expenses: number;
          expected_cash: number | null;
          counted_cash: number | null;
          variance: number | null;
          variance_note: string | null;
          opened_by: string;
          opened_at: string;
          closed_by: string | null;
          closed_at: string | null;
          reconciled_by: string | null;
          reconciled_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          register_id: string;
          device_id?: string | null;
          status?: Database['public']['Enums']['cash_session_status'];
          opening_float?: number;
          cash_sales?: number;
          cash_refunds?: number;
          cash_in?: number;
          cash_out?: number;
          cash_expenses?: number;
          expected_cash?: number | null;
          counted_cash?: number | null;
          variance?: number | null;
          variance_note?: string | null;
          opened_by: string;
          opened_at?: string;
          closed_by?: string | null;
          closed_at?: string | null;
          reconciled_by?: string | null;
          reconciled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          register_id?: string;
          device_id?: string | null;
          status?: Database['public']['Enums']['cash_session_status'];
          opening_float?: number;
          cash_sales?: number;
          cash_refunds?: number;
          cash_in?: number;
          cash_out?: number;
          cash_expenses?: number;
          expected_cash?: number | null;
          counted_cash?: number | null;
          variance?: number | null;
          variance_note?: string | null;
          opened_by?: string;
          opened_at?: string;
          closed_by?: string | null;
          closed_at?: string | null;
          reconciled_by?: string | null;
          reconciled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'cash_sessions_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_sessions_closed_by_fkey';
            columns: ['closed_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_sessions_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_sessions_opened_by_fkey';
            columns: ['opened_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_sessions_reconciled_by_fkey';
            columns: ['reconciled_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_sessions_register_id_fkey';
            columns: ['register_id'];
            isOneToOne: true;
            referencedRelation: 'cash_registers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_sessions_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      categories: {
        Row: {
          id: string;
          tenant_id: string;
          parent_id: string | null;
          name: string;
          description: string | null;
          colour: string | null;
          sort_order: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          parent_id?: string | null;
          name: string;
          description?: string | null;
          colour?: string | null;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          parent_id?: string | null;
          name?: string;
          description?: string | null;
          colour?: string | null;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'categories_parent_id_fkey';
            columns: ['parent_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'categories_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      customers: {
        Row: {
          id: string;
          tenant_id: string;
          name: string;
          phone: string | null;
          email: string | null;
          address: string | null;
          notes: string | null;
          default_tier: Database['public']['Enums']['price_tier'];
          balance: number;
          credit_limit: number;
          is_active: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          name: string;
          phone?: string | null;
          email?: string | null;
          address?: string | null;
          notes?: string | null;
          default_tier?: Database['public']['Enums']['price_tier'];
          balance?: number;
          credit_limit?: number;
          is_active?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          name?: string;
          phone?: string | null;
          email?: string | null;
          address?: string | null;
          notes?: string | null;
          default_tier?: Database['public']['Enums']['price_tier'];
          balance?: number;
          credit_limit?: number;
          is_active?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'customers_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'customers_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      device_activations: {
        Row: {
          id: string;
          tenant_id: string;
          device_id: string;
          code_hash: string;
          code_hint: string;
          expires_at: string;
          max_attempts: number;
          attempt_count: number;
          consumed_at: string | null;
          consumed_by: string | null;
          consumed_ip: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          device_id: string;
          code_hash: string;
          code_hint: string;
          expires_at: string;
          max_attempts?: number;
          attempt_count?: number;
          consumed_at?: string | null;
          consumed_by?: string | null;
          consumed_ip?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          device_id?: string;
          code_hash?: string;
          code_hint?: string;
          expires_at?: string;
          max_attempts?: number;
          attempt_count?: number;
          consumed_at?: string | null;
          consumed_by?: string | null;
          consumed_ip?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'device_activations_consumed_by_fkey';
            columns: ['consumed_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'device_activations_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'device_activations_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: true;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'device_activations_revoked_by_fkey';
            columns: ['revoked_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'device_activations_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      device_sessions: {
        Row: {
          id: string;
          device_id: string;
          tenant_id: string;
          secret_hash: string;
          install_id: string;
          last_seen_at: string;
          expires_at: string;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          device_id: string;
          tenant_id: string;
          secret_hash: string;
          install_id: string;
          last_seen_at?: string;
          expires_at: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          device_id?: string;
          tenant_id?: string;
          secret_hash?: string;
          install_id?: string;
          last_seen_at?: string;
          expires_at?: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'device_sessions_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'device_sessions_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      devices: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          code: string;
          name: string;
          status: Database['public']['Enums']['device_status'];
          platform: Database['public']['Enums']['device_platform'] | null;
          secret_hash: string | null;
          secret_rotated_at: string | null;
          app_version: string | null;
          os_version: string | null;
          last_seen_at: string | null;
          last_sync_at: string | null;
          pending_sync_count: number;
          authorized_until: string | null;
          offline_grace_hours: number;
          activated_at: string | null;
          activated_by: string | null;
          suspended_at: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          revoked_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          code: string;
          name: string;
          status?: Database['public']['Enums']['device_status'];
          platform?: Database['public']['Enums']['device_platform'] | null;
          secret_hash?: string | null;
          secret_rotated_at?: string | null;
          app_version?: string | null;
          os_version?: string | null;
          last_seen_at?: string | null;
          last_sync_at?: string | null;
          pending_sync_count?: number;
          authorized_until?: string | null;
          offline_grace_hours?: number;
          activated_at?: string | null;
          activated_by?: string | null;
          suspended_at?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          revoked_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          code?: string;
          name?: string;
          status?: Database['public']['Enums']['device_status'];
          platform?: Database['public']['Enums']['device_platform'] | null;
          secret_hash?: string | null;
          secret_rotated_at?: string | null;
          app_version?: string | null;
          os_version?: string | null;
          last_seen_at?: string | null;
          last_sync_at?: string | null;
          pending_sync_count?: number;
          authorized_until?: string | null;
          offline_grace_hours?: number;
          activated_at?: string | null;
          activated_by?: string | null;
          suspended_at?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          revoked_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'devices_activated_by_fkey';
            columns: ['activated_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'devices_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'devices_revoked_by_fkey';
            columns: ['revoked_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'devices_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      expense_categories: {
        Row: {
          id: string;
          tenant_id: string;
          name: string;
          description: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          name: string;
          description?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          name?: string;
          description?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'expense_categories_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      expenses: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          category_id: string | null;
          reference: string;
          description: string;
          amount: number;
          method: Database['public']['Enums']['payment_method'];
          payment_reference: string | null;
          receipt_url: string | null;
          status: Database['public']['Enums']['expense_status'];
          expense_date: string;
          cash_session_id: string | null;
          created_by: string;
          approved_by: string | null;
          approved_at: string | null;
          rejected_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          category_id?: string | null;
          reference: string;
          description: string;
          amount: number;
          method?: Database['public']['Enums']['payment_method'];
          payment_reference?: string | null;
          receipt_url?: string | null;
          status?: Database['public']['Enums']['expense_status'];
          expense_date?: string;
          cash_session_id?: string | null;
          created_by: string;
          approved_by?: string | null;
          approved_at?: string | null;
          rejected_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          category_id?: string | null;
          reference?: string;
          description?: string;
          amount?: number;
          method?: Database['public']['Enums']['payment_method'];
          payment_reference?: string | null;
          receipt_url?: string | null;
          status?: Database['public']['Enums']['expense_status'];
          expense_date?: string;
          cash_session_id?: string | null;
          created_by?: string;
          approved_by?: string | null;
          approved_at?: string | null;
          rejected_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'expenses_approved_by_fkey';
            columns: ['approved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'expenses_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'expenses_cash_session_fk';
            columns: ['cash_session_id'];
            isOneToOne: false;
            referencedRelation: 'cash_sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'expenses_category_id_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'expense_categories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'expenses_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'expenses_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      idempotency_keys: {
        Row: {
          id: string;
          tenant_id: string;
          key: string;
          operation: string;
          request_fingerprint: string;
          status: Database['public']['Enums']['idempotency_status'];
          result_id: string | null;
          result: Json | null;
          error_code: string | null;
          device_id: string | null;
          user_id: string | null;
          expires_at: string;
          created_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          key: string;
          operation: string;
          request_fingerprint: string;
          status?: Database['public']['Enums']['idempotency_status'];
          result_id?: string | null;
          result?: Json | null;
          error_code?: string | null;
          device_id?: string | null;
          user_id?: string | null;
          expires_at?: string;
          created_at?: string;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          key?: string;
          operation?: string;
          request_fingerprint?: string;
          status?: Database['public']['Enums']['idempotency_status'];
          result_id?: string | null;
          result?: Json | null;
          error_code?: string | null;
          device_id?: string | null;
          user_id?: string | null;
          expires_at?: string;
          created_at?: string;
          completed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'idempotency_keys_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'idempotency_keys_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'idempotency_keys_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      installations: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string | null;
          reference: string;
          status: Database['public']['Enums']['installation_status'];
          scheduled_for: string | null;
          started_at: string | null;
          completed_at: string | null;
          installer_id: string | null;
          installer_name: string | null;
          location: string | null;
          device_count: number;
          configuration: Json;
          notes: string | null;
          signoff_url: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id?: string | null;
          reference: string;
          status?: Database['public']['Enums']['installation_status'];
          scheduled_for?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          installer_id?: string | null;
          installer_name?: string | null;
          location?: string | null;
          device_count?: number;
          configuration?: Json;
          notes?: string | null;
          signoff_url?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string | null;
          reference?: string;
          status?: Database['public']['Enums']['installation_status'];
          scheduled_for?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          installer_id?: string | null;
          installer_name?: string | null;
          location?: string | null;
          device_count?: number;
          configuration?: Json;
          notes?: string | null;
          signoff_url?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'installations_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'installations_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'installations_installer_id_fkey';
            columns: ['installer_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'installations_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      inventory: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          product_id: string;
          quantity: number;
          reserved: number;
          reorder_level: number;
          last_counted_at: string | null;
          last_movement_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          product_id: string;
          quantity?: number;
          reserved?: number;
          reorder_level?: number;
          last_counted_at?: string | null;
          last_movement_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          product_id?: string;
          quantity?: number;
          reserved?: number;
          reorder_level?: number;
          last_counted_at?: string | null;
          last_movement_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inventory_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'inventory_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'inventory_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      inventory_movements: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          product_id: string;
          movement_type: Database['public']['Enums']['movement_type'];
          quantity: number;
          balance_after: number;
          unit_cost: number;
          reference_type: string | null;
          reference_id: string | null;
          reason: string | null;
          notes: string | null;
          performed_by: string | null;
          device_id: string | null;
          occurred_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          product_id: string;
          movement_type: Database['public']['Enums']['movement_type'];
          quantity: number;
          balance_after: number;
          unit_cost?: number;
          reference_type?: string | null;
          reference_id?: string | null;
          reason?: string | null;
          notes?: string | null;
          performed_by?: string | null;
          device_id?: string | null;
          occurred_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          product_id?: string;
          movement_type?: Database['public']['Enums']['movement_type'];
          quantity?: number;
          balance_after?: number;
          unit_cost?: number;
          reference_type?: string | null;
          reference_id?: string | null;
          reason?: string | null;
          notes?: string | null;
          performed_by?: string | null;
          device_id?: string | null;
          occurred_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inventory_movements_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'inventory_movements_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'inventory_movements_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'inventory_movements_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      maintenance_records: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string | null;
          device_id: string | null;
          reference: string;
          status: Database['public']['Enums']['maintenance_status'];
          priority: Database['public']['Enums']['maintenance_priority'];
          issue: string;
          description: string | null;
          resolution: string | null;
          reported_by: string | null;
          reporter_name: string | null;
          technician_id: string | null;
          reported_at: string;
          acknowledged_at: string | null;
          resolved_at: string | null;
          closed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id?: string | null;
          device_id?: string | null;
          reference: string;
          status?: Database['public']['Enums']['maintenance_status'];
          priority?: Database['public']['Enums']['maintenance_priority'];
          issue: string;
          description?: string | null;
          resolution?: string | null;
          reported_by?: string | null;
          reporter_name?: string | null;
          technician_id?: string | null;
          reported_at?: string;
          acknowledged_at?: string | null;
          resolved_at?: string | null;
          closed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string | null;
          device_id?: string | null;
          reference?: string;
          status?: Database['public']['Enums']['maintenance_status'];
          priority?: Database['public']['Enums']['maintenance_priority'];
          issue?: string;
          description?: string | null;
          resolution?: string | null;
          reported_by?: string | null;
          reporter_name?: string | null;
          technician_id?: string | null;
          reported_at?: string;
          acknowledged_at?: string | null;
          resolved_at?: string | null;
          closed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'maintenance_records_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'maintenance_records_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'maintenance_records_reported_by_fkey';
            columns: ['reported_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'maintenance_records_technician_id_fkey';
            columns: ['technician_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'maintenance_records_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      membership_branches: {
        Row: {
          membership_id: string;
          branch_id: string;
          created_at: string;
        };
        Insert: {
          membership_id: string;
          branch_id: string;
          created_at?: string;
        };
        Update: {
          membership_id?: string;
          branch_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'membership_branches_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'membership_branches_membership_id_fkey';
            columns: ['membership_id'];
            isOneToOne: false;
            referencedRelation: 'tenant_memberships';
            referencedColumns: ['id'];
          },
        ];
      };
      membership_roles: {
        Row: {
          id: string;
          membership_id: string;
          role_id: string;
          branch_id: string | null;
          granted_by: string | null;
          granted_at: string;
        };
        Insert: {
          id?: string;
          membership_id: string;
          role_id: string;
          branch_id?: string | null;
          granted_by?: string | null;
          granted_at?: string;
        };
        Update: {
          id?: string;
          membership_id?: string;
          role_id?: string;
          branch_id?: string | null;
          granted_by?: string | null;
          granted_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'membership_roles_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'membership_roles_granted_by_fkey';
            columns: ['granted_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'membership_roles_membership_id_fkey';
            columns: ['membership_id'];
            isOneToOne: false;
            referencedRelation: 'tenant_memberships';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'membership_roles_role_id_fkey';
            columns: ['role_id'];
            isOneToOne: false;
            referencedRelation: 'roles';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string | null;
          user_id: string | null;
          kind: string;
          severity: Database['public']['Enums']['notification_severity'];
          title: string;
          body: string | null;
          link: string | null;
          metadata: Json;
          read_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id?: string | null;
          user_id?: string | null;
          kind: string;
          severity?: Database['public']['Enums']['notification_severity'];
          title: string;
          body?: string | null;
          link?: string | null;
          metadata?: Json;
          read_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string | null;
          user_id?: string | null;
          kind?: string;
          severity?: Database['public']['Enums']['notification_severity'];
          title?: string;
          body?: string | null;
          link?: string | null;
          metadata?: Json;
          read_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      permissions: {
        Row: {
          key: string;
          resource: string;
          action: string;
          description: string;
          created_at: string;
        };
        Insert: {
          key: string;
          resource: string;
          action: string;
          description: string;
          created_at?: string;
        };
        Update: {
          key?: string;
          resource?: string;
          action?: string;
          description?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      platform_admins: {
        Row: {
          user_id: string;
          granted_by: string | null;
          granted_at: string;
          note: string | null;
          pin_hash: string | null;
          pin_set_at: string | null;
          pin_is_default: boolean;
          last_login_at: string | null;
        };
        Insert: {
          user_id: string;
          granted_by?: string | null;
          granted_at?: string;
          note?: string | null;
          pin_hash?: string | null;
          pin_set_at?: string | null;
          pin_is_default?: boolean;
          last_login_at?: string | null;
        };
        Update: {
          user_id?: string;
          granted_by?: string | null;
          granted_at?: string;
          note?: string | null;
          pin_hash?: string | null;
          pin_set_at?: string | null;
          pin_is_default?: boolean;
          last_login_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'platform_admins_granted_by_fkey';
            columns: ['granted_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'platform_admins_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      platform_pin_throttle: {
        Row: {
          id: boolean;
          consecutive_failures: number;
          locked_until: string | null;
          last_attempt_at: string | null;
        };
        Insert: {
          id?: boolean;
          consecutive_failures?: number;
          locked_until?: string | null;
          last_attempt_at?: string | null;
        };
        Update: {
          id?: boolean;
          consecutive_failures?: number;
          locked_until?: string | null;
          last_attempt_at?: string | null;
        };
        Relationships: [];
      };
      product_barcodes: {
        Row: {
          id: string;
          tenant_id: string;
          product_id: string;
          barcode: string;
          is_primary: boolean;
          pack_size: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          product_id: string;
          barcode: string;
          is_primary?: boolean;
          pack_size?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          product_id?: string;
          barcode?: string;
          is_primary?: boolean;
          pack_size?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'product_barcodes_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: true;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'product_barcodes_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      product_prices: {
        Row: {
          id: string;
          tenant_id: string;
          product_id: string;
          branch_id: string | null;
          tier: Database['public']['Enums']['price_tier'];
          amount: number;
          min_quantity: number;
          effective_from: string;
          effective_to: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          product_id: string;
          branch_id?: string | null;
          tier?: Database['public']['Enums']['price_tier'];
          amount: number;
          min_quantity?: number;
          effective_from?: string;
          effective_to?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          product_id?: string;
          branch_id?: string | null;
          tier?: Database['public']['Enums']['price_tier'];
          amount?: number;
          min_quantity?: number;
          effective_from?: string;
          effective_to?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'product_prices_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'product_prices_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'product_prices_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'product_prices_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      products: {
        Row: {
          id: string;
          tenant_id: string;
          category_id: string | null;
          name: string;
          sku: string;
          description: string | null;
          image_url: string | null;
          unit: string;
          allow_fractional: boolean;
          average_cost: number;
          last_cost: number;
          tax_mode: Database['public']['Enums']['tax_mode'];
          tax_rate: number | null;
          min_stock: number;
          reorder_level: number;
          reorder_quantity: number;
          is_active: boolean;
          is_stock_tracked: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          image_path: string | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          category_id?: string | null;
          name: string;
          sku: string;
          description?: string | null;
          image_url?: string | null;
          unit?: string;
          allow_fractional?: boolean;
          average_cost?: number;
          last_cost?: number;
          tax_mode?: Database['public']['Enums']['tax_mode'];
          tax_rate?: number | null;
          min_stock?: number;
          reorder_level?: number;
          reorder_quantity?: number;
          is_active?: boolean;
          is_stock_tracked?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          image_path?: string | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          category_id?: string | null;
          name?: string;
          sku?: string;
          description?: string | null;
          image_url?: string | null;
          unit?: string;
          allow_fractional?: boolean;
          average_cost?: number;
          last_cost?: number;
          tax_mode?: Database['public']['Enums']['tax_mode'];
          tax_rate?: number | null;
          min_stock?: number;
          reorder_level?: number;
          reorder_quantity?: number;
          is_active?: boolean;
          is_stock_tracked?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          image_path?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'products_category_id_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'products_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'products_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string;
          phone: string | null;
          avatar_url: string | null;
          last_seen_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name: string;
          phone?: string | null;
          avatar_url?: string | null;
          last_seen_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string;
          phone?: string | null;
          avatar_url?: string | null;
          last_seen_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      purchase_items: {
        Row: {
          id: string;
          purchase_id: string;
          tenant_id: string;
          product_id: string;
          line_number: number;
          quantity_ordered: number;
          quantity_received: number;
          unit_cost: number;
          discount_amount: number;
          tax_amount: number;
          line_total: number;
          expiry_date: string | null;
          batch_number: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          purchase_id: string;
          tenant_id: string;
          product_id: string;
          line_number: number;
          quantity_ordered: number;
          quantity_received?: number;
          unit_cost: number;
          discount_amount?: number;
          tax_amount?: number;
          line_total: number;
          expiry_date?: string | null;
          batch_number?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          purchase_id?: string;
          tenant_id?: string;
          product_id?: string;
          line_number?: number;
          quantity_ordered?: number;
          quantity_received?: number;
          unit_cost?: number;
          discount_amount?: number;
          tax_amount?: number;
          line_total?: number;
          expiry_date?: string | null;
          batch_number?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'purchase_items_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchase_items_purchase_id_fkey';
            columns: ['purchase_id'];
            isOneToOne: false;
            referencedRelation: 'purchases';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchase_items_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      purchase_payments: {
        Row: {
          id: string;
          purchase_id: string;
          tenant_id: string;
          branch_id: string;
          method: Database['public']['Enums']['payment_method'];
          amount: number;
          reference: string | null;
          paid_at: string;
          paid_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          purchase_id: string;
          tenant_id: string;
          branch_id: string;
          method: Database['public']['Enums']['payment_method'];
          amount: number;
          reference?: string | null;
          paid_at?: string;
          paid_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          purchase_id?: string;
          tenant_id?: string;
          branch_id?: string;
          method?: Database['public']['Enums']['payment_method'];
          amount?: number;
          reference?: string | null;
          paid_at?: string;
          paid_by?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'purchase_payments_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchase_payments_paid_by_fkey';
            columns: ['paid_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchase_payments_purchase_id_fkey';
            columns: ['purchase_id'];
            isOneToOne: false;
            referencedRelation: 'purchases';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchase_payments_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      purchases: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          supplier_id: string | null;
          reference: string;
          supplier_invoice_no: string | null;
          status: Database['public']['Enums']['purchase_status'];
          payment_status: Database['public']['Enums']['payment_status'];
          subtotal: number;
          discount_amount: number;
          tax_amount: number;
          shipping_amount: number;
          total: number;
          amount_paid: number;
          notes: string | null;
          ordered_at: string | null;
          expected_at: string | null;
          received_at: string | null;
          due_at: string | null;
          created_by: string | null;
          received_by: string | null;
          cancelled_at: string | null;
          cancel_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          supplier_id?: string | null;
          reference: string;
          supplier_invoice_no?: string | null;
          status?: Database['public']['Enums']['purchase_status'];
          payment_status?: Database['public']['Enums']['payment_status'];
          subtotal?: number;
          discount_amount?: number;
          tax_amount?: number;
          shipping_amount?: number;
          total?: number;
          amount_paid?: number;
          notes?: string | null;
          ordered_at?: string | null;
          expected_at?: string | null;
          received_at?: string | null;
          due_at?: string | null;
          created_by?: string | null;
          received_by?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          supplier_id?: string | null;
          reference?: string;
          supplier_invoice_no?: string | null;
          status?: Database['public']['Enums']['purchase_status'];
          payment_status?: Database['public']['Enums']['payment_status'];
          subtotal?: number;
          discount_amount?: number;
          tax_amount?: number;
          shipping_amount?: number;
          total?: number;
          amount_paid?: number;
          notes?: string | null;
          ordered_at?: string | null;
          expected_at?: string | null;
          received_at?: string | null;
          due_at?: string | null;
          created_by?: string | null;
          received_by?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'purchases_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchases_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchases_received_by_fkey';
            columns: ['received_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchases_supplier_id_fkey';
            columns: ['supplier_id'];
            isOneToOne: false;
            referencedRelation: 'suppliers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchases_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      role_permissions: {
        Row: {
          role_id: string;
          permission_key: string;
          granted_at: string;
          granted_by: string | null;
        };
        Insert: {
          role_id: string;
          permission_key: string;
          granted_at?: string;
          granted_by?: string | null;
        };
        Update: {
          role_id?: string;
          permission_key?: string;
          granted_at?: string;
          granted_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'role_permissions_granted_by_fkey';
            columns: ['granted_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'role_permissions_permission_key_fkey';
            columns: ['permission_key'];
            isOneToOne: false;
            referencedRelation: 'permissions';
            referencedColumns: ['key'];
          },
          {
            foreignKeyName: 'role_permissions_role_id_fkey';
            columns: ['role_id'];
            isOneToOne: false;
            referencedRelation: 'roles';
            referencedColumns: ['id'];
          },
        ];
      };
      role_template_permissions: {
        Row: {
          template_key: string;
          permission_key: string;
        };
        Insert: {
          template_key: string;
          permission_key: string;
        };
        Update: {
          template_key?: string;
          permission_key?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'role_template_permissions_permission_key_fkey';
            columns: ['permission_key'];
            isOneToOne: false;
            referencedRelation: 'permissions';
            referencedColumns: ['key'];
          },
          {
            foreignKeyName: 'role_template_permissions_template_key_fkey';
            columns: ['template_key'];
            isOneToOne: false;
            referencedRelation: 'role_templates';
            referencedColumns: ['key'];
          },
        ];
      };
      role_templates: {
        Row: {
          key: string;
          name: string;
          description: string;
          rank: number;
          created_at: string;
        };
        Insert: {
          key: string;
          name: string;
          description: string;
          rank: number;
          created_at?: string;
        };
        Update: {
          key?: string;
          name?: string;
          description?: string;
          rank?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      roles: {
        Row: {
          id: string;
          tenant_id: string;
          key: string;
          name: string;
          description: string | null;
          rank: number;
          is_system: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          key: string;
          name: string;
          description?: string | null;
          rank?: number;
          is_system?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          key?: string;
          name?: string;
          description?: string | null;
          rank?: number;
          is_system?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'roles_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      sale_items: {
        Row: {
          id: string;
          sale_id: string;
          tenant_id: string;
          branch_id: string;
          product_id: string;
          line_number: number;
          product_name: string;
          product_sku: string;
          quantity: number;
          unit_price: number;
          unit_cost: number;
          discount_type: Database['public']['Enums']['discount_type'];
          discount_value: number | null;
          discount_amount: number;
          tax_rate: number;
          tax_amount: number;
          line_total: number;
          quantity_returned: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          sale_id: string;
          tenant_id: string;
          branch_id: string;
          product_id: string;
          line_number: number;
          product_name: string;
          product_sku: string;
          quantity: number;
          unit_price: number;
          unit_cost?: number;
          discount_type?: Database['public']['Enums']['discount_type'];
          discount_value?: number | null;
          discount_amount?: number;
          tax_rate?: number;
          tax_amount?: number;
          line_total: number;
          quantity_returned?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          sale_id?: string;
          tenant_id?: string;
          branch_id?: string;
          product_id?: string;
          line_number?: number;
          product_name?: string;
          product_sku?: string;
          quantity?: number;
          unit_price?: number;
          unit_cost?: number;
          discount_type?: Database['public']['Enums']['discount_type'];
          discount_value?: number | null;
          discount_amount?: number;
          tax_rate?: number;
          tax_amount?: number;
          line_total?: number;
          quantity_returned?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'sale_items_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_items_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_items_sale_id_fkey';
            columns: ['sale_id'];
            isOneToOne: false;
            referencedRelation: 'sales';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_items_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      sale_payments: {
        Row: {
          id: string;
          sale_id: string;
          tenant_id: string;
          branch_id: string;
          method: Database['public']['Enums']['payment_method'];
          amount: number;
          reference: string | null;
          received_at: string;
          received_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          sale_id: string;
          tenant_id: string;
          branch_id: string;
          method: Database['public']['Enums']['payment_method'];
          amount: number;
          reference?: string | null;
          received_at?: string;
          received_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          sale_id?: string;
          tenant_id?: string;
          branch_id?: string;
          method?: Database['public']['Enums']['payment_method'];
          amount?: number;
          reference?: string | null;
          received_at?: string;
          received_by?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'sale_payments_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_payments_received_by_fkey';
            columns: ['received_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_payments_sale_id_fkey';
            columns: ['sale_id'];
            isOneToOne: false;
            referencedRelation: 'sales';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_payments_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      sale_return_items: {
        Row: {
          id: string;
          return_id: string;
          sale_item_id: string;
          tenant_id: string;
          product_id: string;
          quantity: number;
          unit_price: number;
          tax_amount: number;
          line_total: number;
          condition: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          return_id: string;
          sale_item_id: string;
          tenant_id: string;
          product_id: string;
          quantity: number;
          unit_price: number;
          tax_amount?: number;
          line_total: number;
          condition?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          return_id?: string;
          sale_item_id?: string;
          tenant_id?: string;
          product_id?: string;
          quantity?: number;
          unit_price?: number;
          tax_amount?: number;
          line_total?: number;
          condition?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'sale_return_items_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_return_items_return_id_fkey';
            columns: ['return_id'];
            isOneToOne: false;
            referencedRelation: 'sale_returns';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_return_items_sale_item_id_fkey';
            columns: ['sale_item_id'];
            isOneToOne: false;
            referencedRelation: 'sale_items';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_return_items_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      sale_returns: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          sale_id: string;
          return_number: string;
          reason: string;
          notes: string | null;
          subtotal: number;
          tax_amount: number;
          total: number;
          refund_method: Database['public']['Enums']['payment_method'] | null;
          refund_reference: string | null;
          refunded_amount: number;
          restocked: boolean;
          processed_by: string;
          approved_by: string | null;
          device_id: string | null;
          cash_session_id: string | null;
          returned_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          sale_id: string;
          return_number: string;
          reason: string;
          notes?: string | null;
          subtotal: number;
          tax_amount?: number;
          total: number;
          refund_method?: Database['public']['Enums']['payment_method'] | null;
          refund_reference?: string | null;
          refunded_amount?: number;
          restocked?: boolean;
          processed_by: string;
          approved_by?: string | null;
          device_id?: string | null;
          cash_session_id?: string | null;
          returned_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          sale_id?: string;
          return_number?: string;
          reason?: string;
          notes?: string | null;
          subtotal?: number;
          tax_amount?: number;
          total?: number;
          refund_method?: Database['public']['Enums']['payment_method'] | null;
          refund_reference?: string | null;
          refunded_amount?: number;
          restocked?: boolean;
          processed_by?: string;
          approved_by?: string | null;
          device_id?: string | null;
          cash_session_id?: string | null;
          returned_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'sale_returns_approved_by_fkey';
            columns: ['approved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_returns_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_returns_cash_session_fk';
            columns: ['cash_session_id'];
            isOneToOne: false;
            referencedRelation: 'cash_sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_returns_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_returns_processed_by_fkey';
            columns: ['processed_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_returns_sale_id_fkey';
            columns: ['sale_id'];
            isOneToOne: false;
            referencedRelation: 'sales';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sale_returns_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      sales: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          sale_number: string;
          status: Database['public']['Enums']['sale_status'];
          channel: Database['public']['Enums']['sale_channel'];
          customer_id: string | null;
          cashier_id: string;
          device_id: string | null;
          cash_session_id: string | null;
          tier: Database['public']['Enums']['price_tier'];
          subtotal: number;
          discount_amount: number;
          tax_amount: number;
          total: number;
          cost_total: number;
          amount_paid: number;
          change_given: number;
          amount_refunded: number;
          discount_type: Database['public']['Enums']['discount_type'];
          discount_value: number | null;
          discount_reason: string | null;
          discount_approved_by: string | null;
          note: string | null;
          sold_at: string;
          synced_at: string | null;
          is_offline_sale: boolean;
          voided_at: string | null;
          voided_by: string | null;
          void_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          sale_number: string;
          status?: Database['public']['Enums']['sale_status'];
          channel?: Database['public']['Enums']['sale_channel'];
          customer_id?: string | null;
          cashier_id: string;
          device_id?: string | null;
          cash_session_id?: string | null;
          tier?: Database['public']['Enums']['price_tier'];
          subtotal: number;
          discount_amount?: number;
          tax_amount?: number;
          total: number;
          cost_total?: number;
          amount_paid?: number;
          change_given?: number;
          amount_refunded?: number;
          discount_type?: Database['public']['Enums']['discount_type'];
          discount_value?: number | null;
          discount_reason?: string | null;
          discount_approved_by?: string | null;
          note?: string | null;
          sold_at?: string;
          synced_at?: string | null;
          is_offline_sale?: boolean;
          voided_at?: string | null;
          voided_by?: string | null;
          void_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          sale_number?: string;
          status?: Database['public']['Enums']['sale_status'];
          channel?: Database['public']['Enums']['sale_channel'];
          customer_id?: string | null;
          cashier_id?: string;
          device_id?: string | null;
          cash_session_id?: string | null;
          tier?: Database['public']['Enums']['price_tier'];
          subtotal?: number;
          discount_amount?: number;
          tax_amount?: number;
          total?: number;
          cost_total?: number;
          amount_paid?: number;
          change_given?: number;
          amount_refunded?: number;
          discount_type?: Database['public']['Enums']['discount_type'];
          discount_value?: number | null;
          discount_reason?: string | null;
          discount_approved_by?: string | null;
          note?: string | null;
          sold_at?: string;
          synced_at?: string | null;
          is_offline_sale?: boolean;
          voided_at?: string | null;
          voided_by?: string | null;
          void_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'sales_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sales_cash_session_fk';
            columns: ['cash_session_id'];
            isOneToOne: false;
            referencedRelation: 'cash_sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sales_cashier_id_fkey';
            columns: ['cashier_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sales_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sales_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sales_discount_approved_by_fkey';
            columns: ['discount_approved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sales_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sales_voided_by_fkey';
            columns: ['voided_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      stock_count_items: {
        Row: {
          id: string;
          stock_count_id: string;
          tenant_id: string;
          product_id: string;
          expected_quantity: number;
          counted_quantity: number | null;
          variance: number | null;
          unit_cost: number;
          notes: string | null;
          counted_by: string | null;
          counted_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          stock_count_id: string;
          tenant_id: string;
          product_id: string;
          expected_quantity: number;
          counted_quantity?: number | null;
          variance?: number | null;
          unit_cost?: number;
          notes?: string | null;
          counted_by?: string | null;
          counted_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          stock_count_id?: string;
          tenant_id?: string;
          product_id?: string;
          expected_quantity?: number;
          counted_quantity?: number | null;
          variance?: number | null;
          unit_cost?: number;
          notes?: string | null;
          counted_by?: string | null;
          counted_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_count_items_counted_by_fkey';
            columns: ['counted_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_count_items_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_count_items_stock_count_id_fkey';
            columns: ['stock_count_id'];
            isOneToOne: false;
            referencedRelation: 'stock_counts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_count_items_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      stock_counts: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string;
          reference: string;
          status: Database['public']['Enums']['stock_count_status'];
          category_id: string | null;
          notes: string | null;
          started_by: string | null;
          started_at: string | null;
          submitted_at: string | null;
          approved_by: string | null;
          approved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id: string;
          reference: string;
          status?: Database['public']['Enums']['stock_count_status'];
          category_id?: string | null;
          notes?: string | null;
          started_by?: string | null;
          started_at?: string | null;
          submitted_at?: string | null;
          approved_by?: string | null;
          approved_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string;
          reference?: string;
          status?: Database['public']['Enums']['stock_count_status'];
          category_id?: string | null;
          notes?: string | null;
          started_by?: string | null;
          started_at?: string | null;
          submitted_at?: string | null;
          approved_by?: string | null;
          approved_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_counts_approved_by_fkey';
            columns: ['approved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_counts_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: true;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_counts_category_id_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_counts_started_by_fkey';
            columns: ['started_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_counts_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      stock_transfer_items: {
        Row: {
          id: string;
          transfer_id: string;
          tenant_id: string;
          product_id: string;
          quantity_requested: number;
          quantity_sent: number | null;
          quantity_received: number | null;
          unit_cost: number;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          transfer_id: string;
          tenant_id: string;
          product_id: string;
          quantity_requested: number;
          quantity_sent?: number | null;
          quantity_received?: number | null;
          unit_cost?: number;
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          transfer_id?: string;
          tenant_id?: string;
          product_id?: string;
          quantity_requested?: number;
          quantity_sent?: number | null;
          quantity_received?: number | null;
          unit_cost?: number;
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_transfer_items_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_transfer_items_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_transfer_items_transfer_id_fkey';
            columns: ['transfer_id'];
            isOneToOne: false;
            referencedRelation: 'stock_transfers';
            referencedColumns: ['id'];
          },
        ];
      };
      stock_transfers: {
        Row: {
          id: string;
          tenant_id: string;
          reference: string;
          from_branch_id: string;
          to_branch_id: string;
          status: Database['public']['Enums']['transfer_status'];
          notes: string | null;
          requested_by: string | null;
          requested_at: string | null;
          approved_by: string | null;
          approved_at: string | null;
          dispatched_at: string | null;
          received_by: string | null;
          received_at: string | null;
          cancelled_by: string | null;
          cancelled_at: string | null;
          cancel_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          reference: string;
          from_branch_id: string;
          to_branch_id: string;
          status?: Database['public']['Enums']['transfer_status'];
          notes?: string | null;
          requested_by?: string | null;
          requested_at?: string | null;
          approved_by?: string | null;
          approved_at?: string | null;
          dispatched_at?: string | null;
          received_by?: string | null;
          received_at?: string | null;
          cancelled_by?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          reference?: string;
          from_branch_id?: string;
          to_branch_id?: string;
          status?: Database['public']['Enums']['transfer_status'];
          notes?: string | null;
          requested_by?: string | null;
          requested_at?: string | null;
          approved_by?: string | null;
          approved_at?: string | null;
          dispatched_at?: string | null;
          received_by?: string | null;
          received_at?: string | null;
          cancelled_by?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_transfers_approved_by_fkey';
            columns: ['approved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_transfers_cancelled_by_fkey';
            columns: ['cancelled_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_transfers_from_branch_id_fkey';
            columns: ['from_branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_transfers_received_by_fkey';
            columns: ['received_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_transfers_requested_by_fkey';
            columns: ['requested_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_transfers_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_transfers_to_branch_id_fkey';
            columns: ['to_branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
        ];
      };
      subscription_invoices: {
        Row: {
          id: string;
          invoice_number: string;
          tenant_id: string;
          subscription_id: string;
          period_start: string;
          period_end: string;
          amount: number;
          currency_code: string;
          status: Database['public']['Enums']['invoice_status'];
          issued_at: string | null;
          due_at: string;
          paid_at: string | null;
          paid_by_payment_id: string | null;
          cancelled_at: string | null;
          cancel_reason: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          invoice_number: string;
          tenant_id: string;
          subscription_id: string;
          period_start: string;
          period_end: string;
          amount: number;
          currency_code?: string;
          status?: Database['public']['Enums']['invoice_status'];
          issued_at?: string | null;
          due_at: string;
          paid_at?: string | null;
          paid_by_payment_id?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          invoice_number?: string;
          tenant_id?: string;
          subscription_id?: string;
          period_start?: string;
          period_end?: string;
          amount?: number;
          currency_code?: string;
          status?: Database['public']['Enums']['invoice_status'];
          issued_at?: string | null;
          due_at?: string;
          paid_at?: string | null;
          paid_by_payment_id?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'subscription_invoices_paid_by_payment_id_fkey';
            columns: ['paid_by_payment_id'];
            isOneToOne: false;
            referencedRelation: 'subscription_payments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'subscription_invoices_subscription_id_fkey';
            columns: ['subscription_id'];
            isOneToOne: false;
            referencedRelation: 'subscriptions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'subscription_invoices_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      subscription_payments: {
        Row: {
          id: string;
          subscription_id: string;
          tenant_id: string;
          amount: number;
          currency_code: string;
          method: Database['public']['Enums']['payment_method'];
          reference: string | null;
          period_start: string;
          period_end: string;
          paid_at: string;
          recorded_by: string;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          subscription_id: string;
          tenant_id: string;
          amount: number;
          currency_code?: string;
          method?: Database['public']['Enums']['payment_method'];
          reference?: string | null;
          period_start: string;
          period_end: string;
          paid_at?: string;
          recorded_by: string;
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          subscription_id?: string;
          tenant_id?: string;
          amount?: number;
          currency_code?: string;
          method?: Database['public']['Enums']['payment_method'];
          reference?: string | null;
          period_start?: string;
          period_end?: string;
          paid_at?: string;
          recorded_by?: string;
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'subscription_payments_subscription_id_fkey';
            columns: ['subscription_id'];
            isOneToOne: false;
            referencedRelation: 'subscriptions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'subscription_payments_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      subscription_plans: {
        Row: {
          id: string;
          key: string;
          name: string;
          description: string | null;
          price: number;
          currency_code: string;
          interval: Database['public']['Enums']['billing_interval'];
          max_branches: number | null;
          max_devices: number | null;
          max_users: number | null;
          features: Json;
          is_active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          key: string;
          name: string;
          description?: string | null;
          price?: number;
          currency_code?: string;
          interval?: Database['public']['Enums']['billing_interval'];
          max_branches?: number | null;
          max_devices?: number | null;
          max_users?: number | null;
          features?: Json;
          is_active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          key?: string;
          name?: string;
          description?: string | null;
          price?: number;
          currency_code?: string;
          interval?: Database['public']['Enums']['billing_interval'];
          max_branches?: number | null;
          max_devices?: number | null;
          max_users?: number | null;
          features?: Json;
          is_active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: string;
          tenant_id: string;
          plan_id: string;
          status: Database['public']['Enums']['subscription_status'];
          price: number;
          currency_code: string;
          interval: Database['public']['Enums']['billing_interval'];
          current_period_start: string;
          current_period_end: string;
          grace_days: number;
          trial_ends_at: string | null;
          cancelled_at: string | null;
          cancel_reason: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          plan_id: string;
          status?: Database['public']['Enums']['subscription_status'];
          price: number;
          currency_code?: string;
          interval?: Database['public']['Enums']['billing_interval'];
          current_period_start?: string;
          current_period_end: string;
          grace_days?: number;
          trial_ends_at?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          plan_id?: string;
          status?: Database['public']['Enums']['subscription_status'];
          price?: number;
          currency_code?: string;
          interval?: Database['public']['Enums']['billing_interval'];
          current_period_start?: string;
          current_period_end?: string;
          grace_days?: number;
          trial_ends_at?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'subscriptions_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'subscriptions_plan_id_fkey';
            columns: ['plan_id'];
            isOneToOne: false;
            referencedRelation: 'subscription_plans';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'subscriptions_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: true;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      suppliers: {
        Row: {
          id: string;
          tenant_id: string;
          name: string;
          contact_name: string | null;
          phone: string | null;
          email: string | null;
          address: string | null;
          notes: string | null;
          payment_terms_days: number;
          balance: number;
          is_active: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          name: string;
          contact_name?: string | null;
          phone?: string | null;
          email?: string | null;
          address?: string | null;
          notes?: string | null;
          payment_terms_days?: number;
          balance?: number;
          is_active?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          name?: string;
          contact_name?: string | null;
          phone?: string | null;
          email?: string | null;
          address?: string | null;
          notes?: string | null;
          payment_terms_days?: number;
          balance?: number;
          is_active?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'suppliers_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'suppliers_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      sync_conflicts: {
        Row: {
          id: string;
          tenant_id: string;
          branch_id: string | null;
          device_id: string | null;
          conflict_type: Database['public']['Enums']['sync_conflict_type'];
          status: Database['public']['Enums']['sync_conflict_status'];
          entity_type: string;
          entity_id: string | null;
          payload: Json;
          detail: string;
          resolved_by: string | null;
          resolved_at: string | null;
          resolution_note: string | null;
          occurred_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          branch_id?: string | null;
          device_id?: string | null;
          conflict_type: Database['public']['Enums']['sync_conflict_type'];
          status?: Database['public']['Enums']['sync_conflict_status'];
          entity_type: string;
          entity_id?: string | null;
          payload: Json;
          detail: string;
          resolved_by?: string | null;
          resolved_at?: string | null;
          resolution_note?: string | null;
          occurred_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          branch_id?: string | null;
          device_id?: string | null;
          conflict_type?: Database['public']['Enums']['sync_conflict_type'];
          status?: Database['public']['Enums']['sync_conflict_status'];
          entity_type?: string;
          entity_id?: string | null;
          payload?: Json;
          detail?: string;
          resolved_by?: string | null;
          resolved_at?: string | null;
          resolution_note?: string | null;
          occurred_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'sync_conflicts_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sync_conflicts_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sync_conflicts_resolved_by_fkey';
            columns: ['resolved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sync_conflicts_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      tenant_memberships: {
        Row: {
          id: string;
          tenant_id: string;
          user_id: string;
          status: Database['public']['Enums']['membership_status'];
          is_owner: boolean;
          staff_code: string | null;
          job_title: string | null;
          invited_by: string | null;
          invited_at: string;
          accepted_at: string | null;
          suspended_at: string | null;
          removed_at: string | null;
          created_at: string;
          updated_at: string;
          pin_hash: string | null;
          pin_set_at: string | null;
          pin_must_change: boolean;
          last_login_at: string | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          user_id: string;
          status?: Database['public']['Enums']['membership_status'];
          is_owner?: boolean;
          staff_code?: string | null;
          job_title?: string | null;
          invited_by?: string | null;
          invited_at?: string;
          accepted_at?: string | null;
          suspended_at?: string | null;
          removed_at?: string | null;
          created_at?: string;
          updated_at?: string;
          pin_hash?: string | null;
          pin_set_at?: string | null;
          pin_must_change?: boolean;
          last_login_at?: string | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          user_id?: string;
          status?: Database['public']['Enums']['membership_status'];
          is_owner?: boolean;
          staff_code?: string | null;
          job_title?: string | null;
          invited_by?: string | null;
          invited_at?: string;
          accepted_at?: string | null;
          suspended_at?: string | null;
          removed_at?: string | null;
          created_at?: string;
          updated_at?: string;
          pin_hash?: string | null;
          pin_set_at?: string | null;
          pin_must_change?: boolean;
          last_login_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'tenant_memberships_invited_by_fkey';
            columns: ['invited_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tenant_memberships_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: true;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tenant_memberships_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      tenant_pin_throttle: {
        Row: {
          tenant_id: string;
          consecutive_failures: number;
          locked_until: string | null;
          last_attempt_at: string | null;
        };
        Insert: {
          tenant_id: string;
          consecutive_failures?: number;
          locked_until?: string | null;
          last_attempt_at?: string | null;
        };
        Update: {
          tenant_id?: string;
          consecutive_failures?: number;
          locked_until?: string | null;
          last_attempt_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'tenant_pin_throttle_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: true;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      tenant_support_grants: {
        Row: {
          id: string;
          tenant_id: string;
          grantee_id: string;
          reason: string;
          maintenance_id: string | null;
          allow_write: boolean;
          granted_by: string;
          granted_at: string;
          expires_at: string;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          grantee_id: string;
          reason: string;
          maintenance_id?: string | null;
          allow_write?: boolean;
          granted_by: string;
          granted_at?: string;
          expires_at: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          grantee_id?: string;
          reason?: string;
          maintenance_id?: string | null;
          allow_write?: boolean;
          granted_by?: string;
          granted_at?: string;
          expires_at?: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tenant_support_grants_granted_by_fkey';
            columns: ['granted_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tenant_support_grants_grantee_id_fkey';
            columns: ['grantee_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tenant_support_grants_maintenance_id_fkey';
            columns: ['maintenance_id'];
            isOneToOne: false;
            referencedRelation: 'maintenance_records';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tenant_support_grants_tenant_id_fkey';
            columns: ['tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['id'];
          },
        ];
      };
      tenants: {
        Row: {
          id: string;
          slug: string;
          name: string;
          legal_name: string | null;
          status: Database['public']['Enums']['tenant_status'];
          email: string | null;
          phone: string | null;
          address: string | null;
          country_code: string;
          currency_code: string;
          timezone: string;
          logo_url: string | null;
          receipt_footer: string | null;
          tax_registration_no: string | null;
          default_tax_rate: number;
          prices_include_tax: boolean;
          trial_ends_at: string | null;
          suspended_at: string | null;
          suspension_reason: string | null;
          cancelled_at: string | null;
          created_at: string;
          updated_at: string;
          contact_person: string | null;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          legal_name?: string | null;
          status?: Database['public']['Enums']['tenant_status'];
          email?: string | null;
          phone?: string | null;
          address?: string | null;
          country_code?: string;
          currency_code?: string;
          timezone?: string;
          logo_url?: string | null;
          receipt_footer?: string | null;
          tax_registration_no?: string | null;
          default_tax_rate?: number;
          prices_include_tax?: boolean;
          trial_ends_at?: string | null;
          suspended_at?: string | null;
          suspension_reason?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
          contact_person?: string | null;
        };
        Update: {
          id?: string;
          slug?: string;
          name?: string;
          legal_name?: string | null;
          status?: Database['public']['Enums']['tenant_status'];
          email?: string | null;
          phone?: string | null;
          address?: string | null;
          country_code?: string;
          currency_code?: string;
          timezone?: string;
          logo_url?: string | null;
          receipt_footer?: string | null;
          tax_registration_no?: string | null;
          default_tax_rate?: number;
          prices_include_tax?: boolean;
          trial_ends_at?: string | null;
          suspended_at?: string | null;
          suspension_reason?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
          contact_person?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      devices_safe: {
        Row: {
          id: string | null;
          tenant_id: string | null;
          branch_id: string | null;
          code: string | null;
          name: string | null;
          status: Database['public']['Enums']['device_status'] | null;
          platform: Database['public']['Enums']['device_platform'] | null;
          app_version: string | null;
          os_version: string | null;
          last_seen_at: string | null;
          last_sync_at: string | null;
          pending_sync_count: number | null;
          authorized_until: string | null;
          offline_grace_hours: number | null;
          activated_at: string | null;
          revoked_at: string | null;
          revoked_reason: string | null;
          created_at: string | null;
          updated_at: string | null;
          health: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      activate_device: {
        Args: {
          p_code: string;
          p_pepper: string;
          p_install_id: string;
          p_platform?: Database['public']['Enums']['device_platform'] | undefined;
          p_app_version?: string | undefined;
        };
        Returns: {
    device_id: string | null;
    tenant_id: string | null;
    branch_id: string | null;
    device_code: string | null;
    device_name: string | null;
    device_secret: string | null;
    authorized_until: string | null;
  }[];
      };
      add_staff_member: {
        Args: {
          p_tenant_id: string;
          p_user_id: string;
          p_full_name: string;
          p_role_key: string;
          p_pin: string;
          p_branch_ids?: string[] | undefined;
          p_job_title?: string | undefined;
        };
        Returns: string;
      };
      apply_stock_adjustment: {
        Args: {
          p_branch_id: string;
          p_product_id: string;
          p_quantity: number;
          p_movement_type: Database['public']['Enums']['movement_type'];
          p_reason: string;
        };
        Returns: {
    new_quantity: number | null;
  }[];
      };
      apply_stock_count: {
        Args: {
          p_stock_count_id: string;
        };
        Returns: {
    adjusted_count: number | null;
    total_variance: number | null;
  }[];
      };
      approve_expense: {
        Args: {
          p_expense_id: string;
        };
        Returns: {
    approved_expense_id: string | null;
  }[];
      };
      cancel_stock_transfer: {
        Args: {
          p_transfer_id: string;
          p_reason: string;
        };
        Returns: {
    cancelled_transfer_id: string | null;
  }[];
      };
      carl_test_reset: {
        Args: {
          p_preserve: string[];
        };
        Returns: unknown;
      };
      change_my_pin: {
        Args: {
          p_tenant_id: string;
          p_current_pin: string;
          p_new_pin: string;
        };
        Returns: unknown;
      };
      change_platform_pin: {
        Args: {
          p_current_pin: string;
          p_new_pin: string;
        };
        Returns: unknown;
      };
      close_cash_session: {
        Args: {
          p_session_id: string;
          p_counted_cash: number;
          p_variance_note?: string | undefined;
        };
        Returns: {
    expected_cash: number | null;
    counted_cash: number | null;
    variance: number | null;
  }[];
      };
      complete_sale: {
        Args: {
          p_branch_id: string;
          p_items: Json;
          p_payments: Json;
          p_idempotency_key: string;
          p_customer_id?: string | undefined;
          p_tier?: Database['public']['Enums']['price_tier'] | undefined;
          p_device_id?: string | undefined;
          p_device_secret?: string | undefined;
          p_pepper?: string | undefined;
          p_order_discount_type?: Database['public']['Enums']['discount_type'] | undefined;
          p_order_discount_value?: number | undefined;
          p_discount_reason?: string | undefined;
          p_note?: string | undefined;
          p_sold_at?: string | undefined;
          p_channel?: Database['public']['Enums']['sale_channel'] | undefined;
        };
        Returns: {
    sale_id: string | null;
    sale_number: string | null;
    total: number | null;
    amount_paid: number | null;
    change_given: number | null;
    was_replayed: boolean | null;
  }[];
      };
      create_branch: {
        Args: {
          p_tenant_id: string;
          p_name: string;
          p_code: string;
          p_address?: string | undefined;
          p_phone?: string | undefined;
        };
        Returns: string;
      };
      create_purchase: {
        Args: {
          p_branch_id: string;
          p_items: Json;
          p_supplier_id?: string | undefined;
          p_supplier_invoice_no?: string | undefined;
          p_notes?: string | undefined;
          p_expected_at?: string | undefined;
        };
        Returns: {
    purchase_id: string | null;
    reference: string | null;
  }[];
      };
      create_stock_transfer: {
        Args: {
          p_from_branch_id: string;
          p_to_branch_id: string;
          p_items: Json;
          p_notes?: string | undefined;
        };
        Returns: {
    transfer_id: string | null;
    reference: string | null;
  }[];
      };
      device_catalogue: {
        Args: {
          p_device_id: string;
          p_device_secret: string;
          p_pepper: string;
          p_since?: string | undefined;
        };
        Returns: Json;
      };
      device_sync_state: {
        Args: {
          p_device_id: string;
          p_device_secret: string;
          p_pepper: string;
        };
        Returns: {
    tenant_id: string | null;
    branch_id: string | null;
    authorized_until: string | null;
    server_time: string | null;
    catalogue_version: string | null;
  }[];
      };
      dispatch_stock_transfer: {
        Args: {
          p_transfer_id: string;
        };
        Returns: {
    dispatched_count: number | null;
  }[];
      };
      expense_summary: {
        Args: {
          p_tenant_id: string;
          p_from: string;
          p_to: string;
          p_branch_id?: string | undefined;
        };
        Returns: {
    expense_count: number | null;
    total: number | null;
    pending_count: number | null;
    pending_total: number | null;
  }[];
      };
      inventory_overview: {
        Args: {
          p_tenant_id: string;
          p_branch_id?: string | undefined;
        };
        Returns: {
    products: number | null;
    low_stock: number | null;
    out_of_stock: number | null;
  }[];
      };
      issue_activation_code: {
        Args: {
          p_device_id: string;
          p_pepper: string;
          p_valid_hours?: number | undefined;
        };
        Returns: {
    code: string | null;
    expires_at: string | null;
  }[];
      };
      issue_initial_pin: {
        Args: {
          p_tenant_id: string;
        };
        Returns: {
    out_pin: string | null;
    out_email: string | null;
  }[];
      };
      issue_invoice: {
        Args: {
          p_subscription_id: string;
          p_period_start?: string | undefined;
          p_period_end?: string | undefined;
          p_amount?: number | undefined;
          p_due_at?: string | undefined;
          p_notes?: string | undefined;
        };
        Returns: {
    invoice_id: string | null;
    invoice_number: string | null;
    amount: number | null;
    due_at: string | null;
  }[];
      };
      low_stock: {
        Args: {
          p_tenant_id: string;
          p_branch_id?: string | undefined;
          p_limit?: number | undefined;
        };
        Returns: {
    product_id: string | null;
    product_name: string | null;
    branch_id: string | null;
    quantity: number | null;
    reorder_level: number | null;
    shortfall: number | null;
  }[];
      };
      low_stock_items: {
        Args: {
          p_tenant_id: string;
          p_branch_id?: string | undefined;
          p_limit?: number | undefined;
        };
        Returns: {
    product_id: string | null;
    name: string | null;
    sku: string | null;
    branch_id: string | null;
    quantity: number | null;
    reorder_level: number | null;
  }[];
      };
      onboard_client: {
        Args: {
          p_business_name: string;
          p_slug: string;
          p_owner_email: string;
          p_owner_name: string;
          p_owner_user_id: string;
          p_plan_id: string;
          p_branch_name?: string | undefined;
          p_branch_code?: string | undefined;
          p_contact_person?: string | undefined;
          p_email?: string | undefined;
          p_phone?: string | undefined;
          p_address?: string | undefined;
          p_legal_name?: string | undefined;
          p_country_code?: string | undefined;
          p_currency_code?: string | undefined;
          p_timezone?: string | undefined;
          p_trial_days?: number | undefined;
          p_price?: number | undefined;
          p_interval?: Database['public']['Enums']['billing_interval'] | undefined;
          p_grace_days?: number | undefined;
          p_starts_at?: string | undefined;
          p_notes?: string | undefined;
        };
        Returns: {
    tenant_id: string | null;
    branch_id: string | null;
    membership_id: string | null;
    subscription_id: string | null;
    status: Database['public']['Enums']['tenant_status'] | null;
    next_billing_at: string | null;
  }[];
      };
      open_cash_session: {
        Args: {
          p_register_id: string;
          p_opening_float?: number | undefined;
          p_device_id?: string | undefined;
        };
        Returns: {
    session_id: string | null;
  }[];
      };
      payment_method_breakdown: {
        Args: {
          p_tenant_id: string;
          p_from: string;
          p_to: string;
          p_branch_id?: string | undefined;
        };
        Returns: {
    method: Database['public']['Enums']['payment_method'] | null;
    payment_count: number | null;
    amount: number | null;
  }[];
      };
      process_return: {
        Args: {
          p_sale_id: string;
          p_items: Json;
          p_reason: string;
          p_idempotency_key: string;
          p_refund_method?: Database['public']['Enums']['payment_method'] | undefined;
          p_refund_reference?: string | undefined;
          p_restocked?: boolean | undefined;
          p_notes?: string | undefined;
        };
        Returns: {
    return_id: string | null;
    return_number: string | null;
    total: number | null;
    was_replayed: boolean | null;
  }[];
      };
      provision_tenant: {
        Args: {
          p_slug: string;
          p_name: string;
          p_owner_email: string;
          p_owner_name: string;
          p_owner_user_id: string;
          p_branch_name?: string | undefined;
          p_branch_code?: string | undefined;
          p_status?: Database['public']['Enums']['tenant_status'] | undefined;
          p_trial_days?: number | undefined;
        };
        Returns: {
    tenant_id: string | null;
    branch_id: string | null;
    membership_id: string | null;
  }[];
      };
      prune_app_errors: {
        Args: {
        };
        Returns: number;
      };
      reactivate_tenant: {
        Args: {
          p_tenant_id: string;
          p_note?: string | undefined;
        };
        Returns: unknown;
      };
      receive_purchase: {
        Args: {
          p_purchase_id: string;
          p_items: Json;
        };
        Returns: {
    received_count: number | null;
  }[];
      };
      receive_stock_transfer: {
        Args: {
          p_transfer_id: string;
          p_received?: Json | undefined;
        };
        Returns: {
    received_count: number | null;
  }[];
      };
      record_cash_movement: {
        Args: {
          p_session_id: string;
          p_movement_type: Database['public']['Enums']['cash_movement_type'];
          p_amount: number;
          p_reason: string;
          p_notes?: string | undefined;
        };
        Returns: {
    movement_id: string | null;
  }[];
      };
      record_expense: {
        Args: {
          p_branch_id: string;
          p_description: string;
          p_amount: number;
          p_category_id?: string | undefined;
          p_method?: Database['public']['Enums']['payment_method'] | undefined;
          p_reference?: string | undefined;
          p_expense_date?: string | undefined;
          p_receipt_url?: string | undefined;
        };
        Returns: {
    expense_id: string | null;
    reference: string | null;
  }[];
      };
      record_subscription_payment: {
        Args: {
          p_subscription_id: string;
          p_amount: number;
          p_idempotency_key: string;
          p_method?: Database['public']['Enums']['payment_method'] | undefined;
          p_reference?: string | undefined;
          p_paid_at?: string | undefined;
          p_period_start?: string | undefined;
          p_period_end?: string | undefined;
          p_invoice_id?: string | undefined;
          p_notes?: string | undefined;
        };
        Returns: {
    payment_id: string | null;
    subscription_status: Database['public']['Enums']['subscription_status'] | null;
    period_end: string | null;
    was_replayed: boolean | null;
  }[];
      };
      register_device: {
        Args: {
          p_branch_id: string;
          p_name: string;
        };
        Returns: {
    device_id: string | null;
    device_code: string | null;
  }[];
      };
      resolve_sale_price: {
        Args: {
          p_product_id: string;
          p_branch_id: string;
          p_tier?: Database['public']['Enums']['price_tier'] | undefined;
          p_quantity?: number | undefined;
        };
        Returns: {
    product_id: string | null;
    unit_price: number | null;
    tax_mode: Database['public']['Enums']['tax_mode'] | null;
    tax_rate: number | null;
    is_active: boolean | null;
  }[];
      };
      resolve_sync_conflict: {
        Args: {
          p_conflict_id: string;
          p_resolution: Database['public']['Enums']['sync_conflict_status'];
          p_note: string;
        };
        Returns: {
    resolved_conflict_id: string | null;
  }[];
      };
      revoke_device: {
        Args: {
          p_device_id: string;
          p_reason: string;
        };
        Returns: unknown;
      };
      sales_summary: {
        Args: {
          p_tenant_id: string;
          p_from: string;
          p_to: string;
          p_branch_id?: string | undefined;
        };
        Returns: {
    sales_count: number | null;
    gross: number | null;
    discounts: number | null;
    tax: number | null;
    cost: number | null;
    profit: number | null;
    refunds: number | null;
    average_sale: number | null;
    items_sold: number | null;
  }[];
      };
      search_products: {
        Args: {
          p_branch_id: string;
          p_query: string;
          p_tier?: Database['public']['Enums']['price_tier'] | undefined;
          p_limit?: number | undefined;
        };
        Returns: {
    product_id: string | null;
    name: string | null;
    sku: string | null;
    unit: string | null;
    unit_price: number | null;
    quantity: number | null;
    is_exact: boolean | null;
    pack_size: number | null;
  }[];
      };
      set_client_monthly_fee: {
        Args: {
          p_tenant_id: string;
          p_price: number;
          p_note?: string | undefined;
        };
        Returns: unknown;
      };
      set_member_pin: {
        Args: {
          p_membership_id: string;
          p_pin: string;
        };
        Returns: unknown;
      };
      set_product_price: {
        Args: {
          p_product_id: string;
          p_amount: number;
          p_tier?: Database['public']['Enums']['price_tier'] | undefined;
          p_branch_id?: string | undefined;
          p_min_quantity?: number | undefined;
        };
        Returns: {
    price_id: string | null;
  }[];
      };
      set_staff_branches: {
        Args: {
          p_membership_id: string;
          p_branch_ids: string[];
        };
        Returns: unknown;
      };
      set_staff_role: {
        Args: {
          p_membership_id: string;
          p_role_key: string;
        };
        Returns: unknown;
      };
      set_staff_status: {
        Args: {
          p_membership_id: string;
          p_status: string;
        };
        Returns: unknown;
      };
      staff_sales_summary: {
        Args: {
          p_tenant_id: string;
          p_from: string;
          p_to: string;
          p_branch_id?: string | undefined;
        };
        Returns: {
    cashier_id: string | null;
    cashier_name: string | null;
    sales_count: number | null;
    gross: number | null;
    refunds: number | null;
  }[];
      };
      stock_valuation: {
        Args: {
          p_tenant_id: string;
          p_branch_id?: string | undefined;
        };
        Returns: {
    product_count: number | null;
    total_units: number | null;
    cost_value: number | null;
    retail_value: number | null;
  }[];
      };
      suspend_tenant: {
        Args: {
          p_tenant_id: string;
          p_reason: string;
        };
        Returns: unknown;
      };
      sync_offline_sale: {
        Args: {
          p_branch_id: string;
          p_items: Json;
          p_payments: Json;
          p_idempotency_key: string;
          p_sold_at: string;
          p_device_id: string;
          p_device_secret: string;
          p_pepper: string;
          p_customer_id?: string | undefined;
          p_tier?: Database['public']['Enums']['price_tier'] | undefined;
          p_order_discount_type?: Database['public']['Enums']['discount_type'] | undefined;
          p_order_discount_value?: number | undefined;
          p_note?: string | undefined;
        };
        Returns: {
    sale_id: string | null;
    sale_number: string | null;
    total: number | null;
    was_replayed: boolean | null;
    had_conflict: boolean | null;
    conflict_id: string | null;
  }[];
      };
      tenant_dashboard_today: {
        Args: {
          p_tenant_id: string;
          p_branch_id?: string | undefined;
        };
        Returns: {
    sales_count: number | null;
    gross: number | null;
    cost: number | null;
    cash: number | null;
    momo: number | null;
  }[];
      };
      tenant_sales_periods: {
        Args: {
          p_tenant_id: string;
          p_branch_id?: string | undefined;
        };
        Returns: {
    today_count: number | null;
    today_gross: number | null;
    week_count: number | null;
    week_gross: number | null;
    month_count: number | null;
    month_gross: number | null;
    year_count: number | null;
    year_gross: number | null;
  }[];
      };
      top_products: {
        Args: {
          p_tenant_id: string;
          p_from: string;
          p_to: string;
          p_branch_id?: string | undefined;
          p_limit?: number | undefined;
        };
        Returns: {
    product_id: string | null;
    product_name: string | null;
    quantity_sold: number | null;
    revenue: number | null;
    profit: number | null;
  }[];
      };
      upsert_product: {
        Args: {
          p_branch_id: string;
          p_name: string;
          p_sku: string;
          p_retail_price: number;
          p_product_id?: string | undefined;
          p_category_id?: string | undefined;
          p_description?: string | undefined;
          p_unit?: string | undefined;
          p_allow_fractional?: boolean | undefined;
          p_is_stock_tracked?: boolean | undefined;
          p_is_active?: boolean | undefined;
          p_wholesale_price?: number | undefined;
          p_cost_price?: number | undefined;
          p_reorder_level?: number | undefined;
          p_min_stock?: number | undefined;
          p_tax_mode?: Database['public']['Enums']['tax_mode'] | undefined;
          p_tax_rate?: number | undefined;
          p_barcode?: string | undefined;
          p_image_url?: string | undefined;
        };
        Returns: {
    product_id: string | null;
    was_created: boolean | null;
  }[];
      };
      verify_device_staff_pin: {
        Args: {
          p_device_id: string;
          p_device_secret: string;
          p_pepper: string;
          p_pin: string;
        };
        Returns: {
    out_status: string | null;
    out_email: string | null;
    out_user_id: string | null;
    out_must_change: boolean | null;
    out_tenant_name: string | null;
    out_branch_name: string | null;
  }[];
      };
      verify_member_pin: {
        Args: {
          p_tenant_slug: string;
          p_pin: string;
        };
        Returns: {
    out_status: string | null;
    out_user_id: string | null;
    out_email: string | null;
    out_tenant_id: string | null;
    out_must_change: boolean | null;
  }[];
      };
      verify_platform_pin: {
        Args: {
          p_pin: string;
        };
        Returns: {
    status: string | null;
    user_id: string | null;
    email: string | null;
    is_default: boolean | null;
  }[];
      };
      void_sale: {
        Args: {
          p_sale_id: string;
          p_reason: string;
        };
        Returns: {
    voided_sale_id: string | null;
  }[];
      };
    };
    Enums: {
      billing_interval: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
      cash_movement_type: 'IN' | 'OUT' | 'DROP' | 'PICKUP';
      cash_session_status: 'OPEN' | 'CLOSED' | 'RECONCILED';
      device_platform: 'WINDOWS' | 'MACOS' | 'LINUX' | 'WEB' | 'ANDROID' | 'IOS';
      device_status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
      discount_type: 'NONE' | 'PERCENTAGE' | 'AMOUNT';
      expense_status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'PAID';
      idempotency_status: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED';
      installation_status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
      invoice_status: 'DRAFT' | 'ISSUED' | 'PAID' | 'OVERDUE' | 'CANCELLED';
      maintenance_priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
      maintenance_status: 'OPEN' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
      membership_status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
      movement_type: 'OPENING_STOCK' | 'PURCHASE' | 'SALE' | 'SALE_RETURN' | 'PURCHASE_RETURN' | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'STOCK_COUNT' | 'DAMAGE' | 'EXPIRED' | 'THEFT' | 'SALE_VOID';
      notification_severity: 'INFO' | 'WARNING' | 'CRITICAL';
      payment_method: 'CASH' | 'MOMO' | 'BANK_TRANSFER' | 'CARD' | 'CREDIT' | 'OTHER';
      payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
      price_tier: 'RETAIL' | 'WHOLESALE';
      purchase_status: 'DRAFT' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';
      sale_channel: 'POS' | 'ONLINE' | 'MANUAL';
      sale_status: 'COMPLETED' | 'VOIDED' | 'PARTIALLY_RETURNED' | 'RETURNED';
      stock_count_status: 'DRAFT' | 'IN_PROGRESS' | 'PENDING_APPROVAL' | 'APPROVED' | 'CANCELLED';
      subscription_status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';
      sync_conflict_status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';
      sync_conflict_type: 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED' | 'PRODUCT_REMOVED' | 'DUPLICATE_TRANSACTION' | 'DEVICE_REVOKED' | 'TENANT_SUSPENDED' | 'VALIDATION_FAILED';
      tax_mode: 'INCLUSIVE' | 'EXCLUSIVE' | 'EXEMPT';
      tenant_status: 'TRIAL' | 'ACTIVE' | 'GRACE_PERIOD' | 'SUSPENDED' | 'CANCELLED';
      transfer_status: 'DRAFT' | 'REQUESTED' | 'APPROVED' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED';
    };
    CompositeTypes: Record<string, never>;
  };
}


export type Tables = Database['public']['Tables'];
export type Views = Database['public']['Views'];
export type Enums = Database['public']['Enums'];

export type Row<T extends keyof Tables> = Tables[T]['Row'];
export type InsertRow<T extends keyof Tables> = Tables[T]['Insert'];
export type UpdateRow<T extends keyof Tables> = Tables[T]['Update'];
export type ViewRow<T extends keyof Views> = Views[T]['Row'];
