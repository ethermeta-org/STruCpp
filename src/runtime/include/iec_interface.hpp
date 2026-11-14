// SPDX-License-Identifier: GPL-3.0-or-later WITH STruCpp-runtime-exception
// Copyright (C) 2025 Autonomy / OpenPLC Project
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC Interface References
 *
 * An IEC 61131-3 / CODESYS interface variable is a nullable reference to a
 * function block instance, not an embedded value. Before the first
 * assignment (`itf := fb`) or a successful `__QUERYINTERFACE` it is
 * unbound. Generated method calls guard with get() so an unbound call
 * yields the method's zero value instead of dereferencing null — the PLC
 * task must survive a bad program, never crash.
 *
 * All operations are a single pointer copy or compare: no allocation, no
 * exceptions, no logging, safe on the real-time path.
 *
 * Example ST code:
 *   VAR
 *       itf : IAct;
 *       fb  : Provider;   // FUNCTION_BLOCK Provider IMPLEMENTS IAct
 *   END_VAR
 *   itf := fb;            // bind
 *   y := itf.Go();        // virtual dispatch through the reference
 *   ok := __QUERYINTERFACE(fb, itf);
 *
 * Generated C++:
 *   IEC_ITF<IACT> itf;
 *   PROVIDER fb;
 *   itf.bind(fb);
 *   y = (itf.get() != nullptr ? itf->Go() : 0);
 */

#pragma once

#include <cstddef>
#include <type_traits>

namespace strucpp {

/**
 * Nullable reference to a function block instance accessed through one of
 * its interfaces. `T` is the generated abstract class of the interface.
 */
template <typename T>
class IEC_ITF {
public:
    IEC_ITF() : ptr_(nullptr) {}
    IEC_ITF(const IEC_ITF&) = default;
    IEC_ITF& operator=(const IEC_ITF&) = default;
    ~IEC_ITF() = default;

    /**
     * Bind an instance while constructing a temporary. A property setter
     * takes `const IEC_ITF<T>&`, so passing a function block builds that
     * temporary for the call. Copy construction of another IEC_ITF stays
     * on the copy constructor: U* is not convertible to T*.
     */
    template <typename U,
              typename = typename std::enable_if<
                  std::is_convertible<U*, T*>::value &&
                  !std::is_same<typename std::decay<U>::type, IEC_ITF>::value>::type>
    IEC_ITF(U& instance) : ptr_(&instance) {}

    /**
     * Bind to an instance. `U` must derive from `T` (or be `T` itself) —
     * enforced at compile time, so a program the analyzer accepted always
     * upcasts soundly. Accepts a pointer too: nullptr unbinds, which is
     * how a failed __QUERYINTERFACE releases the previous instance.
     */
    template <typename U,
              typename = typename std::enable_if<
                  std::is_convertible<U*, T*>::value>::type>
    void bind(U& instance) {
        ptr_ = &instance;
    }

    template <typename U,
              typename = typename std::enable_if<
                  std::is_convertible<U*, T*>::value>::type>
    void bind(U* instance) {
        ptr_ = instance;
    }

    /**
     * Rebind from another interface reference. A child interface converts
     * to a parent (`s := items[i]` when the element extends `s`'s type).
     * Same-type copies the pointer. __QUERYINTERFACE calls bind again, so
     * a later success replaces the previous instance.
     */
    template <typename U,
              typename = typename std::enable_if<
                  std::is_base_of<T, U>::value>::type>
    void bind(const IEC_ITF<U>& other) {
        ptr_ = other.get();
    }

    /** `itf := 0` unbinds. A non-zero integer is not a reference. */
    template <typename N,
              typename = typename std::enable_if<
                  std::is_integral<N>::value>::type>
    void bind(N value) {
        if (value == 0) ptr_ = nullptr;
    }

    /**
     * Assign a related interface reference. The copy assignment stays the
     * non-template one; this is only the upcast (`I := J` when J extends I).
     */
    template <typename U,
              typename = typename std::enable_if<
                  std::is_base_of<T, U>::value &&
                  !std::is_same<T, U>::value>::type>
    IEC_ITF& operator=(const IEC_ITF<U>& other) noexcept {
        ptr_ = other.get();
        return *this;
    }

    template <typename N,
              typename = typename std::enable_if<
                  std::is_integral<N>::value>::type>
    IEC_ITF& operator=(N value) noexcept {
        if (value == 0) ptr_ = nullptr;
        return *this;
    }

    /** Same instance, including a child interface compared with its parent. */
    template <typename U,
              typename = typename std::enable_if<
                  std::is_base_of<T, U>::value ||
                  std::is_base_of<U, T>::value>::type>
    bool operator==(const IEC_ITF<U>& other) const noexcept {
        return ptr_ == other.get();
    }
    template <typename U,
              typename = typename std::enable_if<
                  std::is_base_of<T, U>::value ||
                  std::is_base_of<U, T>::value>::type>
    bool operator!=(const IEC_ITF<U>& other) const noexcept {
        return !(*this == other);
    }

    /** `itf = 0` / `itf <> 0`. Only zero means unbound. */
    template <typename N,
              typename = typename std::enable_if<
                  std::is_integral<N>::value>::type>
    bool operator==(N value) const noexcept {
        return value == 0 ? ptr_ == nullptr : false;
    }
    template <typename N,
              typename = typename std::enable_if<
                  std::is_integral<N>::value>::type>
    bool operator!=(N value) const noexcept {
        return !(*this == value);
    }

    /** Raw interface pointer; nullptr when unbound. */
    T* get() const { return ptr_; }

    /** Dispatch access — guarded by get() != nullptr at call sites. */
    T* operator->() const { return ptr_; }

    /** True when the reference is bound (one pointer compare). */
    bool bound() const { return ptr_ != nullptr; }

    explicit operator bool() const { return ptr_ != nullptr; }

private:
    T* ptr_;
};

/** `0 = itf` and `0 <> itf`: comparison with zero on the left. */
template <typename N, typename T,
          typename = typename std::enable_if<std::is_integral<N>::value>::type>
bool operator==(N value, const IEC_ITF<T>& itf) noexcept {
    return itf == value;
}
template <typename N, typename T,
          typename = typename std::enable_if<std::is_integral<N>::value>::type>
bool operator!=(N value, const IEC_ITF<T>& itf) noexcept {
    return itf != value;
}

}  // namespace strucpp
