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
