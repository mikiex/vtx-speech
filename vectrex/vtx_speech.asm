;==============================================================================
; VTX Speech player for the Vectrex (AY-3-8912 formant speech). AS09 syntax.
; Version 1.0, MIT (see LICENSE). Background: https://mikiex.github.io/vtx-speech/
;
; Envelope shape 8 is the glottal buzz at the voice pitch; A and B play F1/F2
; as harmonics of it; noise on B for consonants. Registers are set once per
; 50 Hz frame from word tracks written by export.py / the editor.
;
; Define before including:
;   VS_RAM   equ  $CA80      ; 22 bytes
;   VS_DUCK  equ  4          ; channel C volume reduction while speaking (0 = none)
;
;   include "vtx_speech.asm"
;   include "speech_data.asm"
;
; Routines (all may clobber A, B, X; DP any on entry, preserved):
;   Speech_Init         once
;   Speech_Say          X = phrase label; replaces any playing phrase
;   Speech_Busy         Z = 1 when silent
;   Speech_Stop         silence now
;   Speech_Service      once per frame, after your sound code fills
;                       Vec_Music_Work and before Do_Sound
;   Speech_Wait_Recal   optional Wait_Recal replacement: counts late 50 Hz
;                       frames (VIA T2) so speech keeps real time
;
; While speaking the player owns R0-R3, R6, R8, R9, R11-R13 and the A/B bits
; of R7. C is yours, reduced by VS_DUCK. At a phrase end or Speech_Stop, A and
; B are disabled in R7 and set to volume 0.
;
; Cost (MAME): 642 cycles/frame mean while speaking, 812 p95, 1,180 max.
; Checked frame by frame in MAME against the reference player (3,733 frames).
;==============================================================================

;--- BIOS (own names, so this file never clashes with your equates) ----------
VS_BIOS_Wait_Recal  equ  $F192
VS_BIOS_Random      equ  $F517                ; needs DP = $C8
VS_VIA_T2_HIGH      equ  $D009                ; VIA timer 2, high byte
VS_VIA_IFR          equ  $D00D                ; VIA interrupt flags (bit 5: timer 2 done)

;--- The BIOS sound buffer: Vec_Music_Work holds R13 at $C83F up to R0 at $C84C.
; Do_Sound copies it to the chip, writing only registers that differ from
; the shadow copy at Vec_Snd_Shadow ($C800 = R0 ... $C80D = R13).
VS_R0           equ    $C84C
VS_R1           equ    $C84B
VS_R2           equ    $C84A
VS_R3           equ    $C849
VS_R6           equ    $C846
VS_R7           equ    $C845
VS_R8           equ    $C844
VS_R9           equ    $C843
VS_R10          equ    $C842
VS_R11          equ    $C841
VS_R12          equ    $C840
VS_R13          equ    $C83F
VS_Shadow_R13   equ    $C80D

;--- RAM (22 bytes from VS_RAM) ---------------------------------------------
VS_Phrase       equ    VS_RAM+0               ; 2: the next phrase byte
VS_Word         equ    VS_RAM+2               ; 2: the next byte of the word (0: between words)
VS_Left         equ    VS_RAM+4               ; frames left in the current run
VS_Head         equ    VS_RAM+5               ; the run's header byte (bits 5-4 kind, bit 6 noise)
VS_Q1           equ    VS_RAM+6               ; F1 in 16 Hz units
VS_Q2           equ    VS_RAM+7               ; F2 in 16 Hz units
VS_Noise        equ    VS_RAM+8               ; index into VS_Noises
VS_Clock        equ    VS_RAM+9               ; the voice 0..7
VS_Voiced       equ    VS_RAM+10              ; the last frame written was voiced
VS_Ticks        equ    VS_RAM+11              ; 50 Hz frames to play at the next service
VS_Late         equ    VS_RAM+12              ; lateness carried over, in 256-cycle units
VS_Ep           equ    VS_RAM+13              ; envelope period of the voice
VS_Mixer        equ    VS_RAM+14              ; the A and B mixer bits being built
VS_Tmp          equ    VS_RAM+15              ; 2: scratch
VS_Steps        equ    VS_RAM+17              ; frames still to step in this service
VS_Return       equ    VS_RAM+18              ; 2: where a chosen alternative returns to (0: none)
VS_State        equ    VS_RAM+20              ; 2: a phrase to start, or VS_Busy, or VS_Done

;--- Two marker bytes: VS_State points at one of them, or at a new phrase.
VS_Busy:        fcb    $00                    ; a phrase is playing
VS_Done:        fcb    $FF                    ; silent

; Reciprocals for the harmonic lock: R[n] = round(16384 / n), n = 0..63.
VS_Recip:
        fdb    0,16384,8192,5461,4096,3277,2731,2341,2048,1820,1638,1489,1365,1260,1170,1092
        fdb    1024,964,910,862,819,780,745,712,683,655,630,607,585,565,546,529
        fdb    512,496,482,468,455,443,431,420,410,400,390,381,372,364,356,349
        fdb    341,334,328,321,315,309,303,298,293,287,282,278,273,269,264,260

;==============================================================================
; Speech_Init: call once before anything else.
;==============================================================================
Speech_Init:
        ldx    #VS_Done
        stx    >VS_State
        lda    #1
        sta    >VS_Ticks
        clr    >VS_Late
        clr    >VS_Voiced
        rts

;==============================================================================
; Speech_Say: X = a phrase. It starts at the next Speech_Service.
;==============================================================================
Speech_Say:
        stx    >VS_State
        rts

;==============================================================================
; Speech_Busy: Z set when silent (nothing playing and nothing waiting).
;==============================================================================
Speech_Busy:
        ldx    >VS_State
        cmpx   #VS_Done
        rts

;==============================================================================
; Speech_Stop: silence now. Channels A and B go off: mixer and volume.
;==============================================================================
Speech_Stop:
        ldx    #VS_Done
        stx    >VS_State
        bra    VS_Silence

; Silence A and B. Switching tone and noise off is not enough: a channel
; with both off still outputs its volume, and a volume that follows the
; envelope keeps playing the envelope (a buzz at the last pitch). So the
; volumes go to 0 too; your next sound sets its own.
VS_Silence:
        lda    >VS_R7
        ora    #$1B                           ; A and B: tone and noise off
        sta    >VS_R7
        clr    >VS_R8                         ; A and B: volume 0
        clr    >VS_R9
        clr    >VS_Voiced
        rts

;==============================================================================
; Speech_Wait_Recal: use instead of the BIOS Wait_Recal (optional).
; Wait_Recal waits for VIA timer 2, which it set for 30,000 cycles (one
; 50 Hz frame) at the start of the last frame. If the timer has already run
; out, the frame was late: the timer keeps counting down past zero, so its
; high byte, negated, is how late in 256-cycle units. Each 117 units
; (29,952 cycles) is one more 50 Hz frame for speech to step. Reading the
; high byte leaves the timer flag for Wait_Recal.
;==============================================================================
Speech_Wait_Recal:
        lda    >VS_VIA_IFR
        bita   #$20                           ; timer 2 done: the frame ran late
        beq    VS_On_Time
        ldb    >VS_VIA_T2_HIGH                ; counting down past zero
        negb                                  ; cycles late / 256 (rounded up)
        clra
        addb   >VS_Late
        adca   #0
VS_Tick_Loop:
        cmpd   #117                           ; 117 * 256 = 29,952 cycles: one more frame
        blo    VS_Tick_Done
        subd   #117
        inc    >VS_Ticks
        bra    VS_Tick_Loop
VS_Tick_Done:
        stb    >VS_Late                       ; keep the remainder for next time
VS_On_Time:
        jmp    >VS_BIOS_Wait_Recal

;==============================================================================
; Speech_Service: once a frame. Steps the phrase by the frames that have
; passed (1, or more after a late frame with Speech_Wait_Recal) and writes
; the registers of the last one into the BIOS sound buffer.
;==============================================================================
Speech_Service:
        ldx    >VS_State
        cmpx   #VS_Busy
        beq    VS_Continue
        cmpx   #VS_Done
        beq    VS_Idle
        ; A new phrase (Speech_Say stored its address). Its first frame plays now.
        stx    >VS_Phrase
        ldx    #VS_Busy
        stx    >VS_State
        clr    >VS_Word
        clr    >VS_Word+1
        clr    >VS_Return
        clr    >VS_Return+1
        clr    >VS_Left
        clr    >VS_Clock                      ; voice 0 until the phrase sets one
        lda    #1
        bra    VS_Steps_Set
VS_Continue:
        lda    >VS_Ticks
VS_Steps_Set:
        sta    >VS_Steps
VS_Step_Loop:
        bsr    VS_Step                        ; carry: the phrase has ended
        bcs    VS_Ended
        dec    >VS_Steps
        bne    VS_Step_Loop
        lda    #1
        sta    >VS_Ticks
        jmp    >VS_Write
VS_Ended:
        ldx    #VS_Done
        stx    >VS_State
        bsr    VS_Silence
VS_Idle:
        lda    #1
        sta    >VS_Ticks
        rts

;------------------------------------------------------------------------------
; VS_Step: one 50 Hz frame. When the current run is used up, reads phrase
; tokens until the next run starts. Carry set at the end of the phrase.
;
; Phrase bytes:  $00-$3F  say word n         $80-$87  voice 0..7
;                $88      a random voice     $89 n a1..an  one of n alternatives
;                $C1-$FE  silence, 1..62 frames          $FF  end
;------------------------------------------------------------------------------
VS_Step:
        tst    >VS_Left
        lbne   VS_Have                        ; the run goes on
        ldx    >VS_Word
        bne    VS_Header                      ; the next run of this word
VS_Token:
        ldx    >VS_Phrase
        lda    ,x+
        stx    >VS_Phrase
        cmpa   #$80
        blo    VS_Start_Word                  ; $00-$7F: a word
        cmpa   #$FF
        beq    VS_Seq_End
        cmpa   #$C0
        bhi    VS_Pause                       ; $C1-$FE: silence
        cmpa   #$89
        bhs    VS_Choice                      ; $89, $8A: a random choice
        cmpa   #$88
        bne    VS_Set_Clock                   ; $80-$87: a voice
        lbsr   VS_Random                      ; $88: a random voice
VS_Set_Clock:
        anda   #7
        sta    >VS_Clock
        bra    VS_Token
; $FF: the end of an alternative (back to where it was chosen) or of the phrase.
VS_Seq_End:
        ldx    >VS_Return
        lbeq   VS_End
        stx    >VS_Phrase
        clr    >VS_Return
        clr    >VS_Return+1
        bra    VS_Token
; $89 n refs: say one of n alternatives, then go on after the references.
; ($8A n refs: go on with one of n phrases, no return.) Choice = (r * n) >> 8.
VS_Choice:
        ldb    ,x+                            ; n
        pshs   a,b
        stx    >VS_Phrase                     ; the references (VS_Random changes X)
        lbsr   VS_Random
        ldb    1,s
        mul                                   ; A = (r * n) >> 8, below n
        lsla                                  ; n <= 32: offset < 64
        ldx    >VS_Phrase
        ldd    a,x
        std    >VS_Tmp                        ; the chosen sequence
        puls   a,b
        cmpa   #$89
        bne    VS_Jump
        lslb
        abx                                   ; after the n references
        stx    >VS_Return
VS_Jump:
        ldx    >VS_Tmp
        stx    >VS_Phrase
        bra    VS_Token
VS_Pause:
        suba   #$C0
        sta    >VS_Left
        clr    >VS_Head                       ; silent, no noise
        bra    VS_Have
VS_Start_Word:
        lsla                                  ; word numbers < 64: offset < 128 (signed)
        ldx    #VS_Words
        ldx    a,x
; A run's header: bit 7 formant bytes follow (F1, then F2 unless kind 3),
; bit 6 a noise byte follows, bits 5-4 kind (0 silent, 1 voiced, 2 nasal,
; 3 F1 only), bits 3-0 frames - 1. $FF ends the word.
VS_Header:
        lda    ,x+
        cmpa   #$FF
        bne    VS_Run
        clr    >VS_Word                       ; the word's end
        clr    >VS_Word+1
        bra    VS_Token
VS_Run:
        sta    >VS_Head
        bita   #$80                           ; formants follow (else the last run's stay)
        beq    VS_No_Formants
        ldb    ,x+
        stb    >VS_Q1
        anda   #$30
        cmpa   #$30                           ; kind 3: F1 only
        beq    VS_No_Formants
        ldb    ,x+
        stb    >VS_Q2
VS_No_Formants:
        lda    >VS_Head
        bita   #$40
        beq    VS_No_Noise
        ldb    ,x+
        stb    >VS_Noise
VS_No_Noise:
        stx    >VS_Word
        ; Frames at this voice: max(1, (n * S + 64) >> 7), S = 8 * (16 - voice).
        ; Low voices are slower, as on the arcade's speech chip; no run vanishes.
        anda   #$0F
        inca
        ldx    #VS_Clock_Scale
        ldb    >VS_Clock
        ldb    b,x
        mul
        addd   #64
        lslb
        rola
        bne    VS_Length
        inca
VS_Length:
        sta    >VS_Left
VS_Have:
        dec    >VS_Left
        andcc  #$FE
        rts
VS_End:
        orcc   #$01
        rts

; A = a random byte (the BIOS Random needs DP = $C8).
VS_Random:
        pshs   dp
        lda    #$C8
        tfr    a,dp
        jsr    >VS_BIOS_Random
VS_Random_Got:                                ; (the MAME check logs A here)
        puls   dp,pc

;------------------------------------------------------------------------------
; VS_Write: the current frame's registers into the BIOS sound buffer.
;   voiced (kinds 1-3): A plays F1 on the envelope
;   kind 1 (voiced): B plays F2 on the envelope
;   kind 2 (nasal):  B plays F2 at a steady, quiet volume 5
;   noise:           B plays noise (period and volume from VS_Noises)
;   the envelope:    sawtooth (shape 8) at the voice's pitch
;------------------------------------------------------------------------------
VS_Write:
        ldx    #VS_Clock_EP
        ldb    >VS_Clock
        lda    b,x
        sta    >VS_Ep
        lda    #$1B                           ; our mixer bits: A and B tone and noise off
        sta    >VS_Mixer
        ldd    #0
        std    >VS_R1                         ; R1, R0
        std    >VS_R3                         ; R3, R2
        sta    >VS_R8
        sta    >VS_R9
        sta    >VS_R6
        lda    >VS_Head
        anda   #$30
        beq    VS_A_Done                      ; silent: A off
        lda    >VS_Q1                         ; voiced: F1 on A, on the envelope
        lbsr   VS_Tone
        std    >VS_R1
        lda    #$10
        sta    >VS_R8
        lda    #$1A                           ; tone A on
        sta    >VS_Mixer
VS_A_Done:
        lda    >VS_Head
        bita   #$40
        bne    VS_B_Noise
        anda   #$30
        beq    VS_Mix
        cmpa   #$30
        beq    VS_Mix                         ; F1 only: B off
        ldb    #$10                           ; voiced: F2 on the envelope
        cmpa   #$10
        beq    VS_B_Volume
        ldb    #5                             ; nasal: F2 steady and quiet
VS_B_Volume:
        stb    >VS_R9
        lda    >VS_Q2
        lbsr   VS_Tone
        std    >VS_R3
        lda    >VS_Mixer
        anda   #$FD                           ; tone B on
        sta    >VS_Mixer
        bra    VS_Mix
VS_B_Noise:
        ldb    >VS_Noise
        lslb
        ldx    #VS_Noises
        abx
        ldd    ,x                             ; A = noise period, B = volume
        sta    >VS_R6
        stb    >VS_R9
        lda    >VS_Mixer
        anda   #$EF                           ; noise B on
        sta    >VS_Mixer
VS_Mix:
        lda    >VS_R7
        anda   #$24                           ; keep channel C's bits; bits 6-7 stay 0
        ora    >VS_Mixer                      ; (the Vectrex reads its buttons through port A)
        sta    >VS_R7
        lda    >VS_Ep
        sta    >VS_R11
        clr    >VS_R12
        lda    #8                             ; envelope shape 8: repeating sawtooth
        sta    >VS_R13
        lda    >VS_Head
        anda   #$30
        beq    VS_Unvoiced
        tst    >VS_Voiced
        bne    VS_Duck
        ; A voice onset: writing R13 restarts the envelope, so the first pitch
        ; period starts loud. Do_Sound writes a register only when it differs
        ; from the shadow, so spoil the shadow's R13 to force the write.
        lda    #$FF
        sta    >VS_Shadow_R13
        lda    #1
        sta    >VS_Voiced
        bra    VS_Duck
VS_Unvoiced:
        clr    >VS_Voiced
VS_Duck:
        lda    >VS_R10                        ; your channel C, VS_DUCK steps down
        suba   #VS_DUCK
        bcc    VS_Duck_Set
        clra
VS_Duck_Set:
        sta    >VS_R10
        rts

;------------------------------------------------------------------------------
; VS_Tone: D = the tone period for the formant in A (16 Hz units) at the
; envelope period VS_Ep, moved to the nearest harmonic of the pitch, so the
; tone repeats in step with every pitch period (a clean buzz):
;   n  = (q * ep * 179 + 32768) >> 16, clamped to 1..63   (nearest harmonic)
;   TP = (ep * R[n] + 512) >> 10                          (= 16 * ep / n)
; No division: four 8x8 MULs and the reciprocal table. Changes A, B, X.
;------------------------------------------------------------------------------
VS_Tone:
        ldb    >VS_Ep
        mul                                   ; P = q * ep
        pshs   a                              ; P high
        lda    #179
        mul                                   ; P low * 179
        sta    >VS_Tmp                        ; its high byte
        puls   b
        lda    #179
        mul                                   ; P high * 179
        addb   >VS_Tmp
        adca   #0
        addb   #128                           ; + 32768 >> 8
        adca   #0                             ; A = n
        bne    VS_N_Low
        inca
VS_N_Low:
        cmpa   #63
        bls    VS_N_Ok
        lda    #63
VS_N_Ok:
        lsla
        ldx    #VS_Recip
        ldd    a,x                            ; R[n]
        pshs   b                              ; R low
        ldb    >VS_Ep
        mul                                   ; ep * R high
        std    >VS_Tmp
        puls   a
        ldb    >VS_Ep
        mul                                   ; ep * R low
        tfr    a,b
        clra
        addd   >VS_Tmp                        ; (ep * R + 512) >> 8 = ep*Rh + (ep*Rl >> 8) + 2
        addd   #2
        lsra
        rorb
        lsra
        rorb                                  ; >> 2
        rts
