export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      agents: {
        Row: {
          archetype: string
          avatar: number
          bio: string
          cash: number
          created_at: number
          followers: number
          following: Json
          funded_total: number
          handle: string
          id: string
          last_action_at: number
          name: string
          owner_id: string
          persona: string
          realized_pnl: number
          risk: number
          status: string
          strategy: string
        }
        Insert: {
          archetype: string
          avatar?: number
          bio?: string
          cash?: number
          created_at: number
          followers?: number
          following?: Json
          funded_total?: number
          handle: string
          id: string
          last_action_at: number
          name: string
          owner_id: string
          persona: string
          realized_pnl?: number
          risk: number
          status: string
          strategy: string
        }
        Update: {
          archetype?: string
          avatar?: number
          bio?: string
          cash?: number
          created_at?: number
          followers?: number
          following?: Json
          funded_total?: number
          handle?: string
          id?: string
          last_action_at?: number
          name?: string
          owner_id?: string
          persona?: string
          realized_pnl?: number
          risk?: number
          status?: string
          strategy?: string
        }
        Relationships: []
      }
      alert_reads: {
        Row: {
          event_id: string
          owner_id: string
          read_at: string
        }
        Insert: {
          event_id: string
          owner_id?: string
          read_at?: string
        }
        Update: {
          event_id?: string
          owner_id?: string
          read_at?: string
        }
        Relationships: []
      }
      alert_rules: {
        Row: {
          created_at: number
          kind: string
          owner_id: string
          target: string
        }
        Insert: {
          created_at?: number
          kind: string
          owner_id?: string
          target?: string
        }
        Update: {
          created_at?: number
          kind?: string
          owner_id?: string
          target?: string
        }
        Relationships: []
      }
      chain_preparations: {
        Row: {
          cluster: string
          confirmed_at: string | null
          created_at: string
          expires_at: string
          id: string
          kind: string
          message_b64: string
          message_hash: string
          owner_id: string
          payload: Json
          signature: string | null
          signed_transaction_b64: string | null
          subject: string
          submitted_at: string | null
          transaction_b64: string | null
          wallet: string
        }
        Insert: {
          cluster: string
          confirmed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          kind: string
          message_b64: string
          message_hash: string
          owner_id: string
          payload?: Json
          signature?: string | null
          signed_transaction_b64?: string | null
          subject: string
          submitted_at?: string | null
          transaction_b64?: string | null
          wallet: string
        }
        Update: {
          cluster?: string
          confirmed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          kind?: string
          message_b64?: string
          message_hash?: string
          owner_id?: string
          payload?: Json
          signature?: string | null
          signed_transaction_b64?: string | null
          subject?: string
          submitted_at?: string | null
          transaction_b64?: string | null
          wallet?: string
        }
        Relationships: []
      }
      coins: {
        Row: {
          avatar: number
          buys: number
          created_at: number
          creator_id: string
          fees: number
          graduated: boolean
          graduated_at: number | null
          name: string
          raised: number
          sells: number
          symbol: string
          tagline: string
          v_sol: number
          v_tok: number
          volume: number
        }
        Insert: {
          avatar?: number
          buys?: number
          created_at: number
          creator_id: string
          fees?: number
          graduated?: boolean
          graduated_at?: number | null
          name: string
          raised?: number
          sells?: number
          symbol: string
          tagline?: string
          v_sol: number
          v_tok: number
          volume?: number
        }
        Update: {
          avatar?: number
          buys?: number
          created_at?: number
          creator_id?: string
          fees?: number
          graduated?: boolean
          graduated_at?: number | null
          name?: string
          raised?: number
          sells?: number
          symbol?: string
          tagline?: string
          v_sol?: number
          v_tok?: number
          volume?: number
        }
        Relationships: []
      }
      cron_config: {
        Row: {
          id: number
          tick_secret: string
        }
        Insert: {
          id?: number
          tick_secret: string
        }
        Update: {
          id?: number
          tick_secret?: string
        }
        Relationships: []
      }
      cycle_runs: {
        Row: {
          agent_id: string
          bucket: string
          decision: string
          mode: string
          reason: string
          t: number
          trigger: string
        }
        Insert: {
          agent_id: string
          bucket: string
          decision: string
          mode: string
          reason?: string
          t: number
          trigger: string
        }
        Update: {
          agent_id?: string
          bucket?: string
          decision?: string
          mode?: string
          reason?: string
          t?: number
          trigger?: string
        }
        Relationships: []
      }
      events: {
        Row: {
          agent_id: string
          bot_likes: number
          id: string
          kind: string
          parent_id: string | null
          price: number | null
          reply_count: number
          sol: number | null
          symbol: string | null
          t: number
          target_id: string | null
          text: string | null
          tokens: number | null
        }
        Insert: {
          agent_id: string
          bot_likes?: number
          id: string
          kind: string
          parent_id?: string | null
          price?: number | null
          reply_count?: number
          sol?: number | null
          symbol?: string | null
          t: number
          target_id?: string | null
          text?: string | null
          tokens?: number | null
        }
        Update: {
          agent_id?: string
          bot_likes?: number
          id?: string
          kind?: string
          parent_id?: string | null
          price?: number | null
          reply_count?: number
          sol?: number | null
          symbol?: string | null
          t?: number
          target_id?: string | null
          text?: string | null
          tokens?: number | null
        }
        Relationships: []
      }
      garden_meta: {
        Row: {
          id: number
          rng: number
          seq: number
          treasury: number
          updated_at: string
          version: number
        }
        Insert: {
          id?: number
          rng?: number
          seq?: number
          treasury?: number
          updated_at?: string
          version?: number
        }
        Update: {
          id?: number
          rng?: number
          seq?: number
          treasury?: number
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      holdings: {
        Row: {
          agent_id: string
          amount: number
          cost: number
          symbol: string
        }
        Insert: {
          agent_id: string
          amount: number
          cost?: number
          symbol: string
        }
        Update: {
          agent_id?: string
          amount?: number
          cost?: number
          symbol?: string
        }
        Relationships: []
      }
      launch_nonces: {
        Row: {
          created_at: string
          expires_at: string
          identity_id: string
          manifest_hash: string | null
          nonce: string
          owner_id: string
          preparation_id: string | null
          used_at: string | null
        }
        Insert: {
          created_at?: string
          expires_at: string
          identity_id: string
          manifest_hash?: string | null
          nonce: string
          owner_id: string
          preparation_id?: string | null
          used_at?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string
          identity_id?: string
          manifest_hash?: string | null
          nonce?: string
          owner_id?: string
          preparation_id?: string | null
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "launch_nonces_preparation_id_fkey"
            columns: ["preparation_id"]
            isOneToOne: false
            referencedRelation: "chain_preparations"
            referencedColumns: ["id"]
          },
        ]
      }
      launches: {
        Row: {
          base_mint: string
          checked_at: string
          cluster: string
          config: string
          created_at: string
          creator_wallet: string
          damm_v2_pool: string | null
          id: string
          lifecycle: string
          migration_signature: string | null
          owner_id: string
          passport_id: string
          pool: string
          signature: string
          slot: number
        }
        Insert: {
          base_mint: string
          checked_at?: string
          cluster: string
          config: string
          created_at?: string
          creator_wallet: string
          damm_v2_pool?: string | null
          id?: string
          lifecycle?: string
          migration_signature?: string | null
          owner_id: string
          passport_id: string
          pool: string
          signature: string
          slot: number
        }
        Update: {
          base_mint?: string
          checked_at?: string
          cluster?: string
          config?: string
          created_at?: string
          creator_wallet?: string
          damm_v2_pool?: string | null
          id?: string
          lifecycle?: string
          migration_signature?: string | null
          owner_id?: string
          passport_id?: string
          pool?: string
          signature?: string
          slot?: number
        }
        Relationships: [
          {
            foreignKeyName: "launches_passport_id_fkey"
            columns: ["passport_id"]
            isOneToOne: true
            referencedRelation: "passports"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger: {
        Row: {
          agent_id: string | null
          amount: number
          id: string
          kind: string
          note: string
          owner_id: string | null
          symbol: string | null
          t: number
        }
        Insert: {
          agent_id?: string | null
          amount: number
          id: string
          kind: string
          note?: string
          owner_id?: string | null
          symbol?: string | null
          t: number
        }
        Update: {
          agent_id?: string | null
          amount?: number
          id?: string
          kind?: string
          note?: string
          owner_id?: string | null
          symbol?: string | null
          t?: number
        }
        Relationships: []
      }
      owners: {
        Row: {
          created_at: number
          id: string
          vsol: number
          wallet_address: string | null
          wallet_provider: string | null
          wallet_signed_at: number | null
          wallet_verified: boolean
        }
        Insert: {
          created_at: number
          id: string
          vsol?: number
          wallet_address?: string | null
          wallet_provider?: string | null
          wallet_signed_at?: number | null
          wallet_verified?: boolean
        }
        Update: {
          created_at?: number
          id?: string
          vsol?: number
          wallet_address?: string | null
          wallet_provider?: string | null
          wallet_signed_at?: number | null
          wallet_verified?: boolean
        }
        Relationships: []
      }
      passports: {
        Row: {
          base_mint: string
          cluster: string
          created_at: string
          id: string
          identity_id: string
          manifest: Json
          manifest_hash: string
          metadata_hash: string | null
          metadata_uri: string | null
          pool: string
          signature: string
        }
        Insert: {
          base_mint: string
          cluster: string
          created_at?: string
          id?: string
          identity_id: string
          manifest: Json
          manifest_hash: string
          metadata_hash?: string | null
          metadata_uri?: string | null
          pool: string
          signature: string
        }
        Update: {
          base_mint?: string
          cluster?: string
          created_at?: string
          id?: string
          identity_id?: string
          manifest?: Json
          manifest_hash?: string
          metadata_hash?: string | null
          metadata_uri?: string | null
          pool?: string
          signature?: string
        }
        Relationships: [
          {
            foreignKeyName: "passports_identity_id_fkey"
            columns: ["identity_id"]
            isOneToOne: false
            referencedRelation: "pq_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      pq_challenges: {
        Row: {
          cluster: string
          expires_at: string
          genesis_hash: string
          id: string
          issued_at: string
          nonce: string
          owner_id: string
          pq_key_hash: string
          statement: string
          used_at: string | null
          wallet: string
        }
        Insert: {
          cluster: string
          expires_at: string
          genesis_hash: string
          id?: string
          issued_at?: string
          nonce: string
          owner_id: string
          pq_key_hash: string
          statement: string
          used_at?: string | null
          wallet: string
        }
        Update: {
          cluster?: string
          expires_at?: string
          genesis_hash?: string
          id?: string
          issued_at?: string
          nonce?: string
          owner_id?: string
          pq_key_hash?: string
          statement?: string
          used_at?: string | null
          wallet?: string
        }
        Relationships: []
      }
      pq_identities: {
        Row: {
          alg: string
          anchor_signature: string | null
          anchor_slot: number | null
          anchored_at: string | null
          cluster: string
          created_at: string
          genesis_hash: string
          id: string
          key_hash: string
          owner_id: string
          pq_signature: string
          public_key: string
          registration_hash: string
          statement: string
          status: string
          wallet: string
          wallet_signature: string
        }
        Insert: {
          alg?: string
          anchor_signature?: string | null
          anchor_slot?: number | null
          anchored_at?: string | null
          cluster: string
          created_at?: string
          genesis_hash: string
          id?: string
          key_hash: string
          owner_id: string
          pq_signature: string
          public_key: string
          registration_hash: string
          statement: string
          status?: string
          wallet: string
          wallet_signature: string
        }
        Update: {
          alg?: string
          anchor_signature?: string | null
          anchor_slot?: number | null
          anchored_at?: string | null
          cluster?: string
          created_at?: string
          genesis_hash?: string
          id?: string
          key_hash?: string
          owner_id?: string
          pq_signature?: string
          public_key?: string
          registration_hash?: string
          statement?: string
          status?: string
          wallet?: string
          wallet_signature?: string
        }
        Relationships: []
      }
      price_points: {
        Row: {
          id: number
          p: number
          symbol: string
          t: number
        }
        Insert: {
          id?: number
          p: number
          symbol: string
          t: number
        }
        Update: {
          id?: number
          p?: number
          symbol?: string
          t?: number
        }
        Relationships: []
      }
      saves: {
        Row: {
          event_id: string
          kind: string
          owner_id: string
        }
        Insert: {
          event_id: string
          kind: string
          owner_id?: string
        }
        Update: {
          event_id?: string
          kind?: string
          owner_id?: string
        }
        Relationships: []
      }
      thoughts: {
        Row: {
          agent_id: string
          id: number
          mode: string
          t: number
          text: string
        }
        Insert: {
          agent_id: string
          id?: number
          mode?: string
          t: number
          text: string
        }
        Update: {
          agent_id?: string
          id?: number
          mode?: string
          t?: number
          text?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          agent_id: string
          event_id: string
          price: number
          side: string
          sol: number
          symbol: string
          t: number
          tokens: number
        }
        Insert: {
          agent_id: string
          event_id: string
          price: number
          side: string
          sol: number
          symbol: string
          t: number
          tokens: number
        }
        Update: {
          agent_id?: string
          event_id?: string
          price?: number
          side?: string
          sol?: number
          symbol?: string
          t?: number
          tokens?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_chain_submission: {
        Args: {
          _hash: string
          _id: string
          _owner: string
          _signature: string
          _transaction: string
        }
        Returns: {
          cluster: string
          confirmed_at: string | null
          created_at: string
          expires_at: string
          id: string
          kind: string
          message_b64: string
          message_hash: string
          owner_id: string
          payload: Json
          signature: string | null
          signed_transaction_b64: string | null
          subject: string
          submitted_at: string | null
          transaction_b64: string | null
          wallet: string
        }
        SetofOptions: {
          from: "*"
          to: "chain_preparations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      consume_launch_nonce: {
        Args: { _identity: string; _nonce: string; _owner: string }
        Returns: {
          created_at: string
          expires_at: string
          identity_id: string
          manifest_hash: string | null
          nonce: string
          owner_id: string
          preparation_id: string | null
          used_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "launch_nonces"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      consume_pq_challenge: {
        Args: { _id: string; _owner: string }
        Returns: {
          cluster: string
          expires_at: string
          genesis_hash: string
          id: string
          issued_at: string
          nonce: string
          owner_id: string
          pq_key_hash: string
          statement: string
          used_at: string | null
          wallet: string
        }
        SetofOptions: {
          from: "*"
          to: "pq_challenges"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      consume_preparation: {
        Args: { _hash: string; _id: string; _owner: string }
        Returns: {
          cluster: string
          confirmed_at: string | null
          created_at: string
          expires_at: string
          id: string
          kind: string
          message_b64: string
          message_hash: string
          owner_id: string
          payload: Json
          signature: string | null
          signed_transaction_b64: string | null
          subject: string
          submitted_at: string | null
          transaction_b64: string | null
          wallet: string
        }
        SetofOptions: {
          from: "*"
          to: "chain_preparations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_launch_preparation: {
        Args: { _identity: string; _nonce: string; _owner: string; _row: Json }
        Returns: {
          cluster: string
          confirmed_at: string | null
          created_at: string
          expires_at: string
          id: string
          kind: string
          message_b64: string
          message_hash: string
          owner_id: string
          payload: Json
          signature: string | null
          signed_transaction_b64: string | null
          subject: string
          submitted_at: string | null
          transaction_b64: string | null
          wallet: string
        }
        SetofOptions: {
          from: "*"
          to: "chain_preparations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      garden_commit: { Args: { p: Json }; Returns: number }
      my_alerts: {
        Args: { p_limit?: number }
        Returns: {
          event_id: string
          is_read: boolean
          reason: string
          t: number
        }[]
      }
      record_launch_confirmation: {
        Args: { _id: string; _lifecycle: string; _owner: string; _slot: number }
        Returns: string
      }
      register_pq_identity: {
        Args: { _challenge: string; _owner: string; _proof: Json }
        Returns: {
          alg: string
          anchor_signature: string | null
          anchor_slot: number | null
          anchored_at: string | null
          cluster: string
          created_at: string
          genesis_hash: string
          id: string
          key_hash: string
          owner_id: string
          pq_signature: string
          public_key: string
          registration_hash: string
          statement: string
          status: string
          wallet: string
          wallet_signature: string
        }
        SetofOptions: {
          from: "*"
          to: "pq_identities"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
