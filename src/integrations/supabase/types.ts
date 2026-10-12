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
      access_eligibility: {
        Row: {
          active_stake: string | null
          blockers: Json
          checked_at: string
          cluster: string | null
          eligible: boolean
          owner_id: string
          slot: number | null
          wallet: string | null
        }
        Insert: {
          active_stake?: string | null
          blockers?: Json
          checked_at?: string
          cluster?: string | null
          eligible?: boolean
          owner_id: string
          slot?: number | null
          wallet?: string | null
        }
        Update: {
          active_stake?: string | null
          blockers?: Json
          checked_at?: string
          cluster?: string | null
          eligible?: boolean
          owner_id?: string
          slot?: number | null
          wallet?: string | null
        }
        Relationships: []
      }
      access_reports: {
        Row: {
          created_at: string
          digest: string
          id: string
          mint: string
          owner_id: string
          report: Json
          reservation_id: string
        }
        Insert: {
          created_at?: string
          digest: string
          id?: string
          mint: string
          owner_id: string
          report: Json
          reservation_id: string
        }
        Update: {
          created_at?: string
          digest?: string
          id?: string
          mint?: string
          owner_id?: string
          report?: Json
          reservation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "access_reports_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: true
            referencedRelation: "access_reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      access_reservations: {
        Row: {
          action: string
          created_at: string
          day: string
          evidence: Json | null
          finished_at: string | null
          generation: number
          id: string
          input_hash: string | null
          lease_expires_at: string | null
          lease_token: string | null
          owner_id: string
          request_key: string
          result: Json | null
          status: string
          tier: string
          wallet: string | null
        }
        Insert: {
          action: string
          created_at?: string
          day: string
          evidence?: Json | null
          finished_at?: string | null
          generation?: number
          id?: string
          input_hash?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          owner_id: string
          request_key: string
          result?: Json | null
          status?: string
          tier: string
          wallet?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          day?: string
          evidence?: Json | null
          finished_at?: string | null
          generation?: number
          id?: string
          input_hash?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          owner_id?: string
          request_key?: string
          result?: Json | null
          status?: string
          tier?: string
          wallet?: string | null
        }
        Relationships: []
      }
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
      botanist_jobs: {
        Row: {
          accepted: Json | null
          amount: number
          asset: string
          candidate_signature: string | null
          capability_hash: string
          client_hash: string
          created_at: string
          error: string | null
          facilitator: string | null
          fee_payer: string | null
          id: string
          memo: string
          mint: string
          network: string
          pay_to: string
          payer: string | null
          payment_hash: string | null
          payment_tx_b64: string | null
          quote_expires_at: string
          report: Json | null
          report_digest: string | null
          request_hash: string
          resource: string | null
          resource_info: Json | null
          settle_signature: string | null
          settled_at: string | null
          settled_slot: number | null
          status: string
          updated_at: string
        }
        Insert: {
          accepted?: Json | null
          amount: number
          asset: string
          candidate_signature?: string | null
          capability_hash: string
          client_hash: string
          created_at?: string
          error?: string | null
          facilitator?: string | null
          fee_payer?: string | null
          id?: string
          memo: string
          mint: string
          network: string
          pay_to: string
          payer?: string | null
          payment_hash?: string | null
          payment_tx_b64?: string | null
          quote_expires_at: string
          report?: Json | null
          report_digest?: string | null
          request_hash: string
          resource?: string | null
          resource_info?: Json | null
          settle_signature?: string | null
          settled_at?: string | null
          settled_slot?: number | null
          status?: string
          updated_at?: string
        }
        Update: {
          accepted?: Json | null
          amount?: number
          asset?: string
          candidate_signature?: string | null
          capability_hash?: string
          client_hash?: string
          created_at?: string
          error?: string | null
          facilitator?: string | null
          fee_payer?: string | null
          id?: string
          memo?: string
          mint?: string
          network?: string
          pay_to?: string
          payer?: string | null
          payment_hash?: string | null
          payment_tx_b64?: string | null
          quote_expires_at?: string
          report?: Json | null
          report_digest?: string | null
          request_hash?: string
          resource?: string | null
          resource_info?: Json | null
          settle_signature?: string | null
          settled_at?: string | null
          settled_slot?: number | null
          status?: string
          updated_at?: string
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
      greenhouse_evidence: {
        Row: {
          attached_at: string
          content_hash: string
          engine_version: string
          id: string
          origin_agent_id: string
          owner_id: string
          proposal_id: string
          proposal_policy_hash: string | null
          repetitions: number
          run_id: string
          run_policy_hash: string
          scenarios: string[]
        }
        Insert: {
          attached_at?: string
          content_hash: string
          engine_version: string
          id?: string
          origin_agent_id: string
          owner_id: string
          proposal_id: string
          proposal_policy_hash?: string | null
          repetitions: number
          run_id: string
          run_policy_hash: string
          scenarios: string[]
        }
        Update: {
          attached_at?: string
          content_hash?: string
          engine_version?: string
          id?: string
          origin_agent_id?: string
          owner_id?: string
          proposal_id?: string
          proposal_policy_hash?: string | null
          repetitions?: number
          run_id?: string
          run_policy_hash?: string
          scenarios?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "greenhouse_evidence_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "launch_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "greenhouse_evidence_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "greenhouse_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      greenhouse_runs: {
        Row: {
          agent_ids: string[]
          attempts: number
          claimed_at: string
          content_hash: string | null
          created_at: string
          engine_version: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json
          input_hash: string
          lease_expires_at: string | null
          lease_token: string | null
          output: Json | null
          output_hash: string | null
          owner_id: string
          published: boolean
          published_at: string | null
          request_id: string
          status: string
        }
        Insert: {
          agent_ids: string[]
          attempts?: number
          claimed_at?: string
          content_hash?: string | null
          created_at?: string
          engine_version: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input: Json
          input_hash: string
          lease_expires_at?: string | null
          lease_token?: string | null
          output?: Json | null
          output_hash?: string | null
          owner_id: string
          published?: boolean
          published_at?: string | null
          request_id: string
          status?: string
        }
        Update: {
          agent_ids?: string[]
          attempts?: number
          claimed_at?: string
          content_hash?: string | null
          created_at?: string
          engine_version?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json
          input_hash?: string
          lease_expires_at?: string | null
          lease_token?: string | null
          output?: Json | null
          output_hash?: string | null
          owner_id?: string
          published?: boolean
          published_at?: string | null
          request_id?: string
          status?: string
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
      launch_proposals: {
        Row: {
          agent_handle: string
          created_at: string
          id: string
          name: string
          origin_agent_id: string | null
          origin_mode: string | null
          origin_policy_hash: string | null
          reason: string
          status: string
          symbol: string
          tagline: string
        }
        Insert: {
          agent_handle: string
          created_at?: string
          id?: string
          name: string
          origin_agent_id?: string | null
          origin_mode?: string | null
          origin_policy_hash?: string | null
          reason?: string
          status?: string
          symbol: string
          tagline?: string
        }
        Update: {
          agent_handle?: string
          created_at?: string
          id?: string
          name?: string
          origin_agent_id?: string | null
          origin_mode?: string | null
          origin_policy_hash?: string | null
          reason?: string
          status?: string
          symbol?: string
          tagline?: string
        }
        Relationships: []
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
      passport_observations: {
        Row: {
          digest: string
          facts: Json
          id: number
          kind: string
          launch_id: string
          observed_at: string
          observed_slot: number
        }
        Insert: {
          digest: string
          facts: Json
          id?: never
          kind: string
          launch_id: string
          observed_at?: string
          observed_slot: number
        }
        Update: {
          digest?: string
          facts?: Json
          id?: never
          kind?: string
          launch_id?: string
          observed_at?: string
          observed_slot?: number
        }
        Relationships: [
          {
            foreignKeyName: "passport_observations_launch_id_fkey"
            columns: ["launch_id"]
            isOneToOne: false
            referencedRelation: "launches"
            referencedColumns: ["id"]
          },
        ]
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
      pollen_associations: {
        Row: {
          created_at: string
          id: string
          launch_id: string
          owner_id: string
          vault: string
          wallet: string
        }
        Insert: {
          created_at?: string
          id?: string
          launch_id: string
          owner_id: string
          vault: string
          wallet: string
        }
        Update: {
          created_at?: string
          id?: string
          launch_id?: string
          owner_id?: string
          vault?: string
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "pollen_associations_launch_id_fkey"
            columns: ["launch_id"]
            isOneToOne: false
            referencedRelation: "launches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pollen_associations_vault_fkey"
            columns: ["vault"]
            isOneToOne: false
            referencedRelation: "pollen_vaults"
            referencedColumns: ["address"]
          },
        ]
      }
      pollen_vaults: {
        Row: {
          address: string
          base: string | null
          cluster: string
          created_at: string
          created_signature: string | null
          mint: string
          owner_wallet: string
          recipients: Json
          recorded_by: string | null
        }
        Insert: {
          address: string
          base?: string | null
          cluster: string
          created_at?: string
          created_signature?: string | null
          mint: string
          owner_wallet: string
          recipients: Json
          recorded_by?: string | null
        }
        Update: {
          address?: string
          base?: string | null
          cluster?: string
          created_at?: string
          created_signature?: string | null
          mint?: string
          owner_wallet?: string
          recipients?: Json
          recorded_by?: string | null
        }
        Relationships: []
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
      research_receipts: {
        Row: {
          anchor_preparation_id: string | null
          anchor_signature: string | null
          anchor_slot: number | null
          anchor_status: string
          anchored_at: string | null
          created_at: string
          experiment: Json
          id: string
          identity_id: string
          identity_proof: Json | null
          manifest: Json
          manifest_hash: string
          owner_id: string
          public_key: string | null
          published: boolean
          published_at: string | null
          request_id: string
          run_id: string
          signature: string | null
          signed_at: string | null
          status: string
        }
        Insert: {
          anchor_preparation_id?: string | null
          anchor_signature?: string | null
          anchor_slot?: number | null
          anchor_status?: string
          anchored_at?: string | null
          created_at?: string
          experiment: Json
          id: string
          identity_id: string
          identity_proof?: Json | null
          manifest: Json
          manifest_hash: string
          owner_id: string
          public_key?: string | null
          published?: boolean
          published_at?: string | null
          request_id: string
          run_id: string
          signature?: string | null
          signed_at?: string | null
          status?: string
        }
        Update: {
          anchor_preparation_id?: string | null
          anchor_signature?: string | null
          anchor_slot?: number | null
          anchor_status?: string
          anchored_at?: string | null
          created_at?: string
          experiment?: Json
          id?: string
          identity_id?: string
          identity_proof?: Json | null
          manifest?: Json
          manifest_hash?: string
          owner_id?: string
          public_key?: string | null
          published?: boolean
          published_at?: string | null
          request_id?: string
          run_id?: string
          signature?: string | null
          signed_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "research_receipts_anchor_preparation_id_fkey"
            columns: ["anchor_preparation_id"]
            isOneToOne: false
            referencedRelation: "chain_preparations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "research_receipts_identity_id_fkey"
            columns: ["identity_id"]
            isOneToOne: false
            referencedRelation: "pq_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "research_receipts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "greenhouse_runs"
            referencedColumns: ["id"]
          },
        ]
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
      access_acquire: {
        Args: {
          _action: string
          _eligible: boolean
          _evidence: Json
          _input_hash: string
          _key: string
          _lease_secs?: number
          _limit: number
          _max_inflight?: number
          _owner: string
          _wallet: string
        }
        Returns: Json
      }
      access_commit_cycle: {
        Args: {
          _id: string
          _lease: string
          _owner: string
          _result: Json
          p: Json
        }
        Returns: number
      }
      access_finish: {
        Args: { _id: string; _ok: boolean; _owner: string }
        Returns: Json
      }
      access_release: {
        Args: { _id: string; _lease: string; _owner: string }
        Returns: Json
      }
      access_reserve: {
        Args: {
          _action: string
          _base: number
          _eligible: boolean
          _evidence: Json
          _extra: number
          _key: string
          _max_inflight?: number
          _owner: string
        }
        Returns: Json
      }
      access_save_report: {
        Args: {
          _digest: string
          _mint: string
          _owner: string
          _report: Json
          _reservation: string
        }
        Returns: Json
      }
      access_set_eligibility: {
        Args: {
          _active: string
          _blockers: Json
          _cluster: string
          _eligible: boolean
          _owner: string
          _slot: number
          _wallet: string
        }
        Returns: undefined
      }
      access_settle_trial: {
        Args: { _id: string; _lease: string; _owner: string }
        Returns: Json
      }
      access_store_report: {
        Args: {
          _digest: string
          _id: string
          _lease: string
          _mint: string
          _owner: string
          _report: Json
        }
        Returns: Json
      }
      botanist_claim_payment: {
        Args: {
          _cap: string
          _id: string
          _payer: string
          _payment_hash: string
          _tx: string
        }
        Returns: {
          accepted: Json | null
          amount: number
          asset: string
          candidate_signature: string | null
          capability_hash: string
          client_hash: string
          created_at: string
          error: string | null
          facilitator: string | null
          fee_payer: string | null
          id: string
          memo: string
          mint: string
          network: string
          pay_to: string
          payer: string | null
          payment_hash: string | null
          payment_tx_b64: string | null
          quote_expires_at: string
          report: Json | null
          report_digest: string | null
          request_hash: string
          resource: string | null
          resource_info: Json | null
          settle_signature: string | null
          settled_at: string | null
          settled_slot: number | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "botanist_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      botanist_mark_failed: {
        Args: { _id: string; _reason: string }
        Returns: {
          accepted: Json | null
          amount: number
          asset: string
          candidate_signature: string | null
          capability_hash: string
          client_hash: string
          created_at: string
          error: string | null
          facilitator: string | null
          fee_payer: string | null
          id: string
          memo: string
          mint: string
          network: string
          pay_to: string
          payer: string | null
          payment_hash: string | null
          payment_tx_b64: string | null
          quote_expires_at: string
          report: Json | null
          report_digest: string | null
          request_hash: string
          resource: string | null
          resource_info: Json | null
          settle_signature: string | null
          settled_at: string | null
          settled_slot: number | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "botanist_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      botanist_mark_settled: {
        Args: { _id: string; _sig: string; _slot: number }
        Returns: {
          accepted: Json | null
          amount: number
          asset: string
          candidate_signature: string | null
          capability_hash: string
          client_hash: string
          created_at: string
          error: string | null
          facilitator: string | null
          fee_payer: string | null
          id: string
          memo: string
          mint: string
          network: string
          pay_to: string
          payer: string | null
          payment_hash: string | null
          payment_tx_b64: string | null
          quote_expires_at: string
          report: Json | null
          report_digest: string | null
          request_hash: string
          resource: string | null
          resource_info: Json | null
          settle_signature: string | null
          settled_at: string | null
          settled_slot: number | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "botanist_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      botanist_record_candidate: {
        Args: { _id: string; _sig: string }
        Returns: {
          accepted: Json | null
          amount: number
          asset: string
          candidate_signature: string | null
          capability_hash: string
          client_hash: string
          created_at: string
          error: string | null
          facilitator: string | null
          fee_payer: string | null
          id: string
          memo: string
          mint: string
          network: string
          pay_to: string
          payer: string | null
          payment_hash: string | null
          payment_tx_b64: string | null
          quote_expires_at: string
          report: Json | null
          report_digest: string | null
          request_hash: string
          resource: string | null
          resource_info: Json | null
          settle_signature: string | null
          settled_at: string | null
          settled_slot: number | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "botanist_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      botanist_store_report: {
        Args: { _digest: string; _id: string; _report: Json }
        Returns: {
          accepted: Json | null
          amount: number
          asset: string
          candidate_signature: string | null
          capability_hash: string
          client_hash: string
          created_at: string
          error: string | null
          facilitator: string | null
          fee_payer: string | null
          id: string
          memo: string
          mint: string
          network: string
          pay_to: string
          payer: string | null
          payment_hash: string | null
          payment_tx_b64: string | null
          quote_expires_at: string
          report: Json | null
          report_digest: string | null
          request_hash: string
          resource: string | null
          resource_info: Json | null
          settle_signature: string | null
          settled_at: string | null
          settled_slot: number | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "botanist_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
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
      greenhouse_attach_evidence: {
        Args: { _owner: string; _proposal: string; _run: string }
        Returns: {
          attached_at: string
          content_hash: string
          engine_version: string
          id: string
          origin_agent_id: string
          owner_id: string
          proposal_id: string
          proposal_policy_hash: string | null
          repetitions: number
          run_id: string
          run_policy_hash: string
          scenarios: string[]
        }
        SetofOptions: {
          from: "*"
          to: "greenhouse_evidence"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      greenhouse_claim_lease: {
        Args: {
          _agents: string[]
          _engine: string
          _input: Json
          _input_hash: string
          _owner: string
          _request: string
        }
        Returns: Json
      }
      greenhouse_claim_run: {
        Args: {
          _agents: string[]
          _engine: string
          _input: Json
          _input_hash: string
          _owner: string
          _request: string
        }
        Returns: {
          agent_ids: string[]
          attempts: number
          claimed_at: string
          content_hash: string | null
          created_at: string
          engine_version: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json
          input_hash: string
          lease_expires_at: string | null
          lease_token: string | null
          output: Json | null
          output_hash: string | null
          owner_id: string
          published: boolean
          published_at: string | null
          request_id: string
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "greenhouse_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      greenhouse_fail_lease: {
        Args: { _id: string; _lease: string; _owner: string; _reason: string }
        Returns: Json
      }
      greenhouse_fail_run: {
        Args: { _id: string; _owner: string; _reason: string }
        Returns: {
          agent_ids: string[]
          attempts: number
          claimed_at: string
          content_hash: string | null
          created_at: string
          engine_version: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json
          input_hash: string
          lease_expires_at: string | null
          lease_token: string | null
          output: Json | null
          output_hash: string | null
          owner_id: string
          published: boolean
          published_at: string | null
          request_id: string
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "greenhouse_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      greenhouse_finalize_lease: {
        Args: {
          _content_hash: string
          _id: string
          _input_hash: string
          _lease: string
          _output: Json
          _output_hash: string
          _owner: string
        }
        Returns: Json
      }
      greenhouse_finalize_run: {
        Args: {
          _content_hash: string
          _id: string
          _input_hash: string
          _output: Json
          _output_hash: string
          _owner: string
        }
        Returns: {
          agent_ids: string[]
          attempts: number
          claimed_at: string
          content_hash: string | null
          created_at: string
          engine_version: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json
          input_hash: string
          lease_expires_at: string | null
          lease_token: string | null
          output: Json | null
          output_hash: string | null
          owner_id: string
          published: boolean
          published_at: string | null
          request_id: string
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "greenhouse_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      greenhouse_set_published: {
        Args: { _id: string; _owner: string; _published: boolean }
        Returns: {
          agent_ids: string[]
          attempts: number
          claimed_at: string
          content_hash: string | null
          created_at: string
          engine_version: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json
          input_hash: string
          lease_expires_at: string | null
          lease_token: string | null
          output: Json | null
          output_hash: string | null
          owner_id: string
          published: boolean
          published_at: string | null
          request_id: string
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "greenhouse_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
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
      research_create_anchor_preparation: {
        Args: { _id: string; _owner: string; _row: Json }
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
      research_create_draft: {
        Args: { _owner: string; _r: Json; _request: string }
        Returns: Json
      }
      research_record_anchor: {
        Args: {
          _id: string
          _ok: boolean
          _owner: string
          _prep: string
          _signature: string
          _slot: number
        }
        Returns: Json
      }
      research_set_published: {
        Args: { _id: string; _owner: string; _published: boolean }
        Returns: Json
      }
      research_sign: {
        Args: {
          _hash: string
          _id: string
          _owner: string
          _proof: Json
          _public_key: string
          _signature: string
        }
        Returns: Json
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
