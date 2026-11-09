import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react'

type NumericInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number | null | undefined
  onValueChange: (value: number | null) => void
  allowEmpty?: boolean
}

/** Keeps the text being edited intact while numeric state updates on each valid keystroke. */
export function NumericInput({ value, onValueChange, allowEmpty = false, onBlur, onFocus, ...props }: NumericInputProps) {
  const committed = value == null ? '' : String(value)
  const [inputValue, setInputValue] = useState(committed)
  const [blurVersion, setBlurVersion] = useState(0)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setInputValue(committed)
  }, [committed, blurVersion])

  return <input {...props} type="number" value={inputValue}
    onFocus={event => { focused.current = true; onFocus?.(event) }}
    onChange={event => {
      const raw = event.currentTarget.value
      setInputValue(raw)
      if (raw === '') {
        if (allowEmpty) onValueChange(null)
        return
      }
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) onValueChange(parsed)
    }}
    onBlur={event => {
      focused.current = false
      const raw = event.currentTarget.value
      if (raw === '') {
        if (allowEmpty) onValueChange(null)
      } else {
        const parsed = Number(raw)
        if (Number.isFinite(parsed)) onValueChange(parsed)
      }
      setBlurVersion(version => version + 1)
      onBlur?.(event)
    }} />
}
